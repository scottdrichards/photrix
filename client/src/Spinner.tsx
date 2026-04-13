const sizeClass: Record<string, string> = {
  "extra-tiny": "spinner-xs",
  tiny: "spinner-sm",
  small: "spinner-sm",
};

type SpinnerProps = {
  label?: string;
  size?: "extra-tiny" | "tiny" | "small";
};

export const Spinner = ({ label, size }: SpinnerProps) => (
  <span className="spinner-wrapper">
    <span
      className={`spinner-dot${size ? ` ${sizeClass[size] ?? ""}` : ""}`}
      aria-hidden="true"
    />
    {label ? <span>{label}</span> : null}
  </span>
);
