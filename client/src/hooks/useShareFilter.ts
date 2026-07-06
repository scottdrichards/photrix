// True if this page was opened from a share link (token was present in the URL).
export const isSharedView = (): boolean => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("token");
};

export const buildShareUrl = (token: string): string => {
  const url = new URL(window.location.origin);
  url.searchParams.set("token", token);
  return url.toString();
};
