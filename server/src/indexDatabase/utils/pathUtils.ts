export const normalizeFolderPath = (value: string): string => {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  if (withLeading === "/") {
    return "/";
  }
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
};
