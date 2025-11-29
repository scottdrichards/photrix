import { describe, it, expect, jest } from "@jest/globals";
import * as http from "http";
import { statusRequestHandler } from "./statusRequestHandler.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { FileScanner } from "../indexDatabase/fileScanner.ts";

describe("statusRequestHandler", () => {
  it("returns the correct status structure", () => {
    // Mock dependencies
    const mockDatabase = {
      getSize: jest.fn().mockReturnValue(42),
    } as unknown as IndexDatabase;

    const mockFileScanner = {
      jobQueues: {
        info: { files: ["a"], active: true, total: 10 },
        exifMetadata: { files: [], active: false, total: 5 },
        aiMetadata: { files: ["b", "c"], active: true, total: 20 },
        faceMetadata: { files: [], active: false, total: 0 },
      },
      scannedFilesCount: 123,
    } as unknown as FileScanner;

    // Mock Request and Response
    const req = {} as http.IncomingMessage;
    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    } as unknown as http.ServerResponse;

    // Call the handler
    statusRequestHandler(req, res, {
      database: mockDatabase,
      fileScanner: mockFileScanner,
    });

    // Assertions
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });

    const expectedStatus = {
      databaseSize: 42,
      queues: {
        info: { length: 1, active: true, total: 10 },
        exifMetadata: { length: 0, active: false, total: 5 },
        aiMetadata: { length: 2, active: true, total: 20 },
        faceMetadata: { length: 0, active: false, total: 0 },
      },
      scannedFilesCount: 123,
    };

    expect(res.end).toHaveBeenCalledWith(JSON.stringify(expectedStatus));
  });
});
