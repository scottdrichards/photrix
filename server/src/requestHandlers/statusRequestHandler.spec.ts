import { describe, it, expect, jest } from "@jest/globals";
import * as http from "http";
import { statusRequestHandler } from "./statusRequestHandler.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { FileScanner } from "../indexDatabase/fileScanner.ts";

describe("statusRequestHandler", () => {
  it("returns the correct status structure", () => {
    const mockDatabase = {
      getSize: jest.fn().mockReturnValue(42),
      countMissingInfo: jest.fn().mockReturnValue(5),
      countMissingDateTaken: jest.fn().mockReturnValue(3),
      countNeedingThumbnails: jest.fn().mockReturnValue(7),
      countMediaEntries: jest.fn().mockReturnValue(20),
    } as unknown as IndexDatabase;

    const mockFileScanner = {
      scannedFilesCount: 25,
      thumbnailMaintenanceActive: true,
      exifMaintenanceActive: false,
      latestThumbnail: { relativePath: "thumb.jpg", completedAt: "2024-01-01T00:00:00Z" },
      latestExif: { relativePath: "meta.jpg", completedAt: "2024-01-01T01:00:00Z" },
    } as unknown as FileScanner;

    const req = {} as http.IncomingMessage;
    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    } as unknown as http.ServerResponse;

    statusRequestHandler(req, res, {
      database: mockDatabase,
      fileScanner: mockFileScanner,
    });

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });

    const payload = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
    expect(payload).toMatchObject({
      databaseSize: 42,
      scannedFilesCount: 25,
      pending: { info: 5, exif: 3, thumbnails: 7 },
      maintenance: { thumbnailActive: true, exifActive: false },
      recent: {
        thumbnail: { relativePath: "thumb.jpg" },
        exif: { relativePath: "meta.jpg" },
      },
    });

    expect(payload.progress.info.percent).toBeCloseTo((42 - 5) / 42, 5);
    expect(payload.progress.exif.percent).toBeCloseTo((20 - 3) / 20, 5);
    expect(payload.progress.thumbnails.percent).toBeCloseTo((20 - 7) / 20, 5);
  });
});
