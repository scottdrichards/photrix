import css from "../PhotoEditor.module.css";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultVal?: number;
  onChange: (v: number) => void;
}
export function Slider({ label, value, min, max, step = 1, defaultVal = 0, onChange }: SliderProps) {
  return (
    <div className={css.sliderRow}>
      <div className={css.sliderHeader}>
        <span className={css.sliderLabel}>{label}</span>
        {value !== defaultVal && (
          <button
            type="button"
            className={css.sliderReset}
            onClick={() => onChange(defaultVal)}
            aria-label={`Reset ${label}`}
            title="Reset"
          >
            ↺
          </button>
        )}
        <span className={css.sliderValue}>{value > 0 ? `+${value}` : String(value)}</span>
      </div>
      <input
        type="range"
        className={css.sliderInput}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(defaultVal)}
      />
    </div>
  );
}

// ─── CropBox ───────────────────────────────────────────────────────────────
