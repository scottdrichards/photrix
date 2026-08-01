import { fetchJsonOrThrow } from "./http";

export type FeedbackStatus = "open" | "active" | "completed";

export type FeedbackItem = {
  id: number;
  text: string;
  createdAt: number;
  claimedAt: number | null;
  claimedBy: string | null;
  completedAt: number | null;
  status: FeedbackStatus;
};

export const fetchFeedbackItems = async (): Promise<FeedbackItem[]> => {
  const payload = await fetchJsonOrThrow<{ feedback: FeedbackItem[] }>(
    "/api/feedback",
    "fetch feedback items",
  );
  return payload.feedback;
};
