export const cx = (...args: (string | undefined | false | null)[]) =>
  args.filter(Boolean).join(" ");
