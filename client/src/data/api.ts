import { Filter } from "../contexts/filterContext";

export type MediaDirectoryResult = Array<{
  path: string;
  type: "folder" | "file";
}>;


export const mediaURLBase = new URL("/media/", window.location.origin);

export const getSubfolders = async (
  folder: string,
): Promise<Array<string>> => {
  const url = new URL(folder, mediaURLBase);
  url.searchParams.set("type", "folders");
  const response = await fetch(url);
  const data = await response.json();
  return data.folders;
};

export const getColumnDistinctValues = async (
  column: string,
  filter: Filter,
  folder: string = "",
  containsText?: string
): Promise<Array<string>> => {
  const url = new URL(folder, mediaURLBase);
  url.searchParams.set("type", "column-values");
  url.searchParams.set("column", column);
  if (containsText) {
    url.searchParams.set("containsText", containsText);
  }
  Object.entries(filter).forEach(([key, value]) => {
    url.searchParams.set(key, JSON.stringify(value));
  });
  const response = await fetch(url);
  return response.json();
};
