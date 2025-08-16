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

type Params = {
  column: string,
  filter: Filter,
  containsText?: string
}
export const getColumnDistinctValues = async (
  params: Params
): Promise<Array<string>> => {
  const { column, filter, containsText } = params;
  const url = new URL(filter.parentFolder ?? "", mediaURLBase);
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

export type FileInfo = {
  name: string;
  parent_path: string;
  keywords?: string[];
  date_taken?: number;
  date_modified?: number;
  rating?: number;
  camera_make?: string;
  camera_model?: string;
  lens_model?: string;
  focal_length?: string;
  aperture?: string;
  shutter_speed?: string;
  iso?: string;
  hierarchical_subject?: string;
  image_width?: number;
  image_height?: number;
  orientation?: number;
  date_indexed: number;
};

export const getFileInfo = async (filePath: string): Promise<FileInfo> => {
  const url = new URL(mediaURLBase);
  // Ensure filePath doesn't start with / to avoid replacing the entire path
  const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  url.pathname = url.pathname + cleanPath;
  url.searchParams.set("info", "true");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to get file info: ${response.statusText}`);
  }
  return response.json();
};
