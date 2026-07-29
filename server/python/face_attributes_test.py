#!/usr/bin/env python3
"""Unit tests for the per-face attribute derivation.

Deliberately model-free: every case builds synthetic landmarks and crops, so the
suite needs nothing but numpy and runs in milliseconds. Run with

    server/.venv/bin/python -m unittest discover -s server/python -p '*_test.py'

or via `npm --prefix server run test:python`.
"""
from __future__ import annotations

import math
import unittest

import numpy as np

import face_attributes as fa


def _ellipse(centre, half_width, half_height, count=8, rotation=0.0):
    """`count` points evenly spaced around an ellipse, optionally rotated."""
    angles = np.linspace(0.0, 2.0 * math.pi, count, endpoint=False)
    points = np.stack([half_width * np.cos(angles), half_height * np.sin(angles)], axis=1)
    cos_r, sin_r = math.cos(rotation), math.sin(rotation)
    rotate = np.array([[cos_r, -sin_r], [sin_r, cos_r]])
    return points @ rotate.T + np.asarray(centre, dtype=np.float64)


class FakeFace(dict):
    """Stands in for an InsightFace `Face` (an attribute-accessible dict)."""

    def __init__(self, bbox, **entries):
        super().__init__(entries)
        self.bbox = np.asarray(bbox, dtype=np.float32)


def _landmarks106(*, eye_height=10.0, mouth_half_width=40.0, corner_lift=0.0,
                  mouth_opening=6.0):
    """A synthetic upright 106-point face.

    Only the groups the derivation reads are meaningful; the rest is filler, which
    is itself part of what the tests check — nothing may depend on the untouched
    points.
    """
    landmarks = np.zeros((106, 2), dtype=np.float64)
    # Eyes at y=100, 80px apart, centred on x=100.
    landmarks[33:43] = _ellipse((60.0, 100.0), 20.0, eye_height, count=10)
    landmarks[87:97] = _ellipse((140.0, 100.0), 20.0, eye_height, count=10)
    # Mouth at y=180, i.e. below the eyes in image coordinates.
    mouth = _ellipse((100.0, 180.0), mouth_half_width, mouth_opening, count=20)
    # Raise the outermost points to simulate lifted corners.
    left = int(np.argmin(mouth[:, 0]))
    right = int(np.argmax(mouth[:, 0]))
    mouth[left, 1] -= corner_lift
    mouth[right, 1] -= corner_lift
    landmarks[52:72] = mouth
    return landmarks


class EyeOpennessTests(unittest.TestCase):
    def test_wide_open_eyes_score_one(self):
        score = fa._eyes_open_score(_landmarks106(eye_height=8.0), fa._LM106_GROUPS)
        self.assertEqual(score, 1.0)

    def test_closed_eyes_score_zero(self):
        # A blink collapses the lid separation while the corners stay put.
        score = fa._eyes_open_score(_landmarks106(eye_height=1.0), fa._LM106_GROUPS)
        self.assertEqual(score, 0.0)

    def test_score_rises_monotonically_as_the_lids_open(self):
        scores = [
            fa._eyes_open_score(_landmarks106(eye_height=height), fa._LM106_GROUPS)
            for height in (0.5, 2.0, 3.0, 4.0, 8.0)
        ]
        self.assertEqual(scores, sorted(scores))
        self.assertEqual(scores[0], 0.0)
        self.assertEqual(scores[-1], 1.0)
        # A half-open eye must land strictly between, not snap to an extreme.
        self.assertTrue(any(0.0 < score < 1.0 for score in scores))

    def test_the_worse_eye_decides(self):
        # One eye wide open, the other shut: the face is not "eyes open".
        landmarks = _landmarks106(eye_height=8.0)
        landmarks[87:97] = _ellipse((140.0, 100.0), 20.0, 0.5, count=10)
        self.assertEqual(fa._eyes_open_score(landmarks, fa._LM106_GROUPS), 0.0)

    def test_head_roll_does_not_change_the_score(self):
        upright = _landmarks106(eye_height=8.0)
        angle = math.radians(30.0)
        rotate = np.array(
            [[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]
        )
        rolled = upright @ rotate.T
        self.assertAlmostEqual(
            fa._eyes_open_score(upright, fa._LM106_GROUPS),
            fa._eyes_open_score(rolled, fa._LM106_GROUPS),
            places=6,
        )


class SmileTests(unittest.TestCase):
    def test_neutral_mouth_scores_zero(self):
        landmarks = _landmarks106(mouth_half_width=34.0, corner_lift=0.0)
        self.assertEqual(fa._smile_score(landmarks, fa._LM106_GROUPS), 0.0)

    def test_raised_corners_alone_register_a_smile(self):
        # A closed-lip smile: the mouth barely widens, the corners lift.
        landmarks = _landmarks106(mouth_half_width=34.0, corner_lift=12.0)
        self.assertGreater(fa._smile_score(landmarks, fa._LM106_GROUPS), 0.5)

    def test_wide_mouth_alone_registers_a_smile(self):
        # A broad open grin: the jaw drops far enough that the corners sit level
        # with the middle of the opening, so lift alone would read as neutral.
        landmarks = _landmarks106(
            mouth_half_width=48.0, corner_lift=0.0, mouth_opening=18.0
        )
        self.assertEqual(fa._smile_features(landmarks, fa._LM106_GROUPS)[0], 0.0)
        self.assertGreater(fa._smile_score(landmarks, fa._LM106_GROUPS), 0.5)

    def test_mouth_width_is_measured_in_interocular_units(self):
        # Scaling the whole face must not change the score.
        landmarks = _landmarks106(mouth_half_width=45.0, corner_lift=8.0)
        small = fa._smile_score(landmarks, fa._LM106_GROUPS)
        large = fa._smile_score(landmarks * 3.7, fa._LM106_GROUPS)
        self.assertAlmostEqual(small, large, places=6)

    def test_head_roll_does_not_change_the_score(self):
        landmarks = _landmarks106(mouth_half_width=45.0, corner_lift=10.0)
        angle = math.radians(-25.0)
        rotate = np.array(
            [[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]
        )
        self.assertAlmostEqual(
            fa._smile_score(landmarks, fa._LM106_GROUPS),
            fa._smile_score(landmarks @ rotate.T, fa._LM106_GROUPS),
            places=6,
        )


class FocusTests(unittest.TestCase):
    """Focus fixtures use a structured pattern rather than white noise.

    White noise is pathological for a contrast-normalised sharpness measure —
    its Laplacian energy sits two orders of magnitude above anything a camera
    produces, so it cannot distinguish sharp from blurred. The block-and-ripple
    pattern below lands in the same energy range as real library faces (~0.3
    sharp), which is what makes these thresholds meaningful.
    """

    @staticmethod
    def _detailed_crop(size=200):
        axis = np.arange(size)
        pattern = (
            60.0
            + 80.0 * ((axis[None, :] // 17) % 2) * ((axis[:, None] // 23) % 2)
            + 40.0 * np.sin(axis[None, :] / 9.0)
        )
        gray = np.clip(pattern, 0, 255).astype(np.uint8)
        return np.repeat(gray[:, :, None], 3, axis=2)

    @staticmethod
    def _blur(crop, radius):
        from PIL import Image, ImageFilter

        return np.asarray(
            Image.fromarray(crop).filter(ImageFilter.GaussianBlur(radius))
        )

    def test_sharp_detail_scores_high(self):
        self.assertGreater(fa._focus_score(self._detailed_crop()), 0.9)

    def test_blurred_detail_scores_low(self):
        blurred = self._blur(self._detailed_crop(), radius=3)
        self.assertLess(fa._focus_score(blurred), 0.2)

    def test_score_falls_monotonically_with_blur(self):
        crop = self._detailed_crop()
        scores = [
            fa._focus_score(crop if radius == 0 else self._blur(crop, radius))
            for radius in (0, 1, 2, 3, 5)
        ]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_tiny_faces_are_unknown_not_blurry(self):
        # Upsampling a sub-threshold crop manufactures blur that is not in the
        # photo, so the honest answer is "unknown".
        small = self._detailed_crop(size=fa.MIN_FOCUS_CROP_PX - 1)
        self.assertIsNone(fa._focus_score(small))

    def test_flat_low_contrast_crop_is_unknown(self):
        self.assertIsNone(fa._focus_score(np.full((200, 200, 3), 128, dtype=np.uint8)))

    def test_sharpness_is_judged_relative_to_face_size(self):
        # The same sharp content captured at two sizes must score alike —
        # "sharp for its size", not "big".
        big = self._detailed_crop(size=400)
        downsampled = fa._resize_gray(fa._to_gray(big), 200)
        small = np.repeat(
            np.clip(downsampled, 0, 255).astype(np.uint8)[:, :, None], 3, axis=2
        )
        self.assertAlmostEqual(fa._focus_score(big), fa._focus_score(small), delta=0.2)


class ExposureTests(unittest.TestCase):
    def test_midtone_face_is_well_exposed(self):
        crop = np.full((100, 100, 3), 128, dtype=np.uint8)
        self.assertEqual(fa._exposure_score(crop), 1.0)

    def test_crushed_shadows_score_low(self):
        crop = np.zeros((100, 100, 3), dtype=np.uint8)
        self.assertLess(fa._exposure_score(crop), 0.5)

    def test_blown_highlights_score_low(self):
        crop = np.full((100, 100, 3), 255, dtype=np.uint8)
        self.assertLess(fa._exposure_score(crop), 0.3)

    def test_a_little_specular_clipping_is_tolerated(self):
        crop = np.full((100, 100, 3), 130, dtype=np.uint8)
        crop[:2, :] = 255  # 2% of the face
        self.assertGreater(fa._exposure_score(crop), 0.8)


class ComputeFaceAttributesTests(unittest.TestCase):
    @staticmethod
    def _image(size=400, seed=1):
        rng = np.random.default_rng(seed)
        return rng.integers(0, 256, size=(size, size, 3), dtype=np.uint8)

    def test_returns_all_four_attributes_for_a_frontal_face(self):
        face = FakeFace(
            (40, 40, 240, 240),
            landmark_2d_106=_landmarks106(eye_height=8.0, corner_lift=12.0),
            pose=np.array([0.0, 5.0, 0.0]),
        )
        attributes = fa.compute_face_attributes(self._image(), face)
        self.assertEqual(
            sorted(attributes), ["exposure", "eyesOpen", "focus", "smile"]
        )
        for value in attributes.values():
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, 1.0)

    def test_profile_faces_report_expression_as_unknown(self):
        face = FakeFace(
            (40, 40, 240, 240),
            landmark_2d_106=_landmarks106(),
            pose=np.array([0.0, fa.MAX_YAW_DEGREES + 10.0, 0.0]),
        )
        attributes = fa.compute_face_attributes(self._image(), face)
        # Crop statistics are still meaningful side-on; the geometry is not.
        self.assertNotIn("smile", attributes)
        self.assertNotIn("eyesOpen", attributes)
        self.assertIn("focus", attributes)
        self.assertIn("exposure", attributes)

    def test_missing_landmarks_still_yield_crop_statistics(self):
        face = FakeFace((40, 40, 240, 240))
        attributes = fa.compute_face_attributes(self._image(), face)
        self.assertEqual(sorted(attributes), ["exposure", "focus"])

    def test_falls_back_to_the_68_point_markup(self):
        landmarks = np.zeros((68, 2), dtype=np.float64)
        landmarks[36:42] = _ellipse((60.0, 100.0), 20.0, 8.0, count=6)
        landmarks[42:48] = _ellipse((140.0, 100.0), 20.0, 8.0, count=6)
        landmarks[48:68] = _ellipse((100.0, 180.0), 40.0, 6.0, count=20)
        face = FakeFace((40, 40, 240, 240), landmark_3d_68=landmarks)
        attributes = fa.compute_face_attributes(self._image(), face)
        self.assertIn("eyesOpen", attributes)
        self.assertIn("smile", attributes)

    def test_a_degenerate_box_yields_no_crop_statistics(self):
        face = FakeFace((10, 10, 11, 11), landmark_2d_106=_landmarks106())
        attributes = fa.compute_face_attributes(self._image(), face)
        self.assertNotIn("focus", attributes)
        self.assertNotIn("exposure", attributes)


if __name__ == "__main__":
    unittest.main()
