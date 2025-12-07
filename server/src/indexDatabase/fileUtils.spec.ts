import { describe, it, expect } from "@jest/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFileInfo, getExifMetadataFromFile } from "../fileHandling/fileUtils.ts";

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
		expect(metadata.dimensions?.width).toBeGreaterThan(0);
		expect(metadata.dimensions?.height).toBeGreaterThan(0);
		expect(metadata.dateTaken).toBeInstanceOf(Date);
			expect(metadata.dateTaken?.getTime()).toBeGreaterThan(0);
	});

	it("extracts metadata from problematic JPG file", async () => {
		const filePath = resolveExamplePath("subFolder/20120803_160939.jpg");

		const metadata = await getExifMetadataFromFile(filePath);

		// Verify location is properly converted to decimal degrees (not an array)
		expect(metadata.location).toBeDefined();
		expect(typeof metadata.location?.latitude).toBe("number");
		expect(typeof metadata.location?.longitude).toBe("number");
		expect(metadata.location?.latitude).toBeCloseTo(40.706096, 4);
		expect(metadata.location?.longitude).toBeCloseTo(110.932840, 4);
		
		// Verify other metadata
		expect(metadata.dimensions?.width).toBe(3264);
		expect(metadata.dimensions?.height).toBe(2448);
		expect(metadata.cameraMake).toBe("SAMSUNG");
	});
});
