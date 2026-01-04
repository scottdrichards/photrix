import { describe, it, expect } from "@jest/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFileInfo, getExifMetadataFromFile } from "./fileUtils.ts";

const EXAMPLE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../exampleFolder",
);

const resolveExamplePath = (...segments: string[]): string => {
	return path.join(EXAMPLE_ROOT, ...segments);
};

describe("getFileInfo", () => {
	it("returns file statistics for sample image", async () => {
		const filePath = resolveExamplePath("sewing-threads.heic");

		const info = await getFileInfo(filePath);

		expect(info.sizeInBytes).toBeGreaterThan(0);
		expect(info.created).toBeInstanceOf(Date);
		expect(info.modified).toBeInstanceOf(Date);
		expect(Number.isNaN(info.created?.getTime() ?? NaN)).toBe(false);
		expect(Number.isNaN(info.modified?.getTime() ?? NaN)).toBe(false);
	});

	it("throws when provided a directory path", async () => {
		const directoryPath = resolveExamplePath();

		await expect(getFileInfo(directoryPath)).rejects.toThrow(/not a file/i);
	});
});

describe("getExifMetadataFromFile", () => {
	it("extracts camera metadata from sample image", async () => {
		const filePath = resolveExamplePath("sewing-threads.heic");

		const metadata = await getExifMetadataFromFile(filePath);

		expect(metadata.cameraMake?.toLowerCase()).toBe("samsung");
		expect(metadata.dimensionWidth).toBe(4000);
		expect(metadata.dimensionHeight).toBe(3000);
		expect(metadata.dateTaken).toBeInstanceOf(Date);
		expect(metadata.dateTaken?.getTime()).toBeGreaterThan(0);
	});
});
