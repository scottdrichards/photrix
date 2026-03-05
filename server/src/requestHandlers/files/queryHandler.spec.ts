import { describe, expect, it, jest } from "@jest/globals";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { queryHandler } from "./queryHandler.ts";

const createMockResponse = (endImpl?: (chunk?: string) => unknown) => {
  let body = "";

  const res = {
    writeHead: jest.fn(),
    end: jest.fn((chunk?: string) => {
      if (endImpl) {
        return endImpl(chunk);
      }
      if (chunk) {
        body += chunk;
      }
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;

  return {
    res,
    getBody: () => body,
  };
};

describe("queryHandler", () => {
  it("returns date range aggregate response", async () => {
    const { res, getBody } = createMockResponse();
    const database = {
      getDateRange: jest.fn(() => ({
        minDate: new Date("2024-01-01T00:00:00.000Z"),
        maxDate: new Date("2024-12-31T00:00:00.000Z"),
      })),
    } as unknown as IndexDatabase;

    await queryHandler(new URL("http://localhost/api/files/?aggregate=dateRange"), "/", database, res);

    expect(database.getDateRange).toHaveBeenCalled();
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      minDate: new Date("2024-01-01T00:00:00.000Z").getTime(),
      maxDate: new Date("2024-12-31T00:00:00.000Z").getTime(),
    });
  });

  it("returns date histogram aggregate response", async () => {
    const { res, getBody } = createMockResponse();
    const histogram = {
      buckets: [{ start: 1, end: 2, count: 3 }],
      bucketSizeMs: 1,
      minDate: 1,
      maxDate: 2,
      grouping: "day" as const,
    };
    const database = {
      getDateHistogram: jest.fn(() => histogram),
    } as unknown as IndexDatabase;

    await queryHandler(
      new URL("http://localhost/api/files/?aggregate=dateHistogram"),
      "/",
      database,
      res,
    );

    expect(database.getDateHistogram).toHaveBeenCalled();
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual(histogram);
  });

  it("returns cluster response with parsed bounds and default cluster size", async () => {
    const { res, getBody } = createMockResponse();
    const database = {
      queryGeoClusters: jest.fn(() => ({ clusters: [{ latitude: 1, longitude: 2, count: 1, samplePath: null, sampleName: null }], total: 1 })),
    } as unknown as IndexDatabase;

    await queryHandler(
      new URL(
        "http://localhost/api/files/?cluster=true&west=-1&east=1&north=2&south=-2",
      ),
      "/photos",
      database,
      res,
    );

    expect(database.queryGeoClusters).toHaveBeenCalledWith({
      filter: { folder: { folder: "/photos", recursive: false } },
      clusterSize: 0.00002,
      bounds: { west: -1, east: 1, north: 2, south: -2 },
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody()).total).toBe(1);
  });

  it("returns count-only response when count=true", async () => {
    const { res, getBody } = createMockResponse();
    const database = {
      queryFiles: jest.fn(async () => ({ items: [{ fileName: "a.jpg", folder: "/" }], total: 12, page: 1, pageSize: 10 })),
    } as unknown as IndexDatabase;

    await queryHandler(
      new URL("http://localhost/api/files/?count=true&metadata=mimeType,folder&page=2&pageSize=5"),
      "/",
      database,
      res,
    );

    expect(database.queryFiles).toHaveBeenCalled();
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({ count: 12 });
  });

  it("returns 413 when response serialization fails with invalid string length", async () => {
    let shouldThrow = true;
    const { res } = createMockResponse((chunk?: string) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("Invalid string length");
      }
      return chunk;
    });
    const database = {
      queryFiles: jest.fn(async () => ({ items: [{ fileName: "a.jpg", folder: "/" }], total: 1, page: 1, pageSize: 1 })),
    } as unknown as IndexDatabase;

    await queryHandler(new URL("http://localhost/api/files/"), "/", database, res);

    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(413);
    const payloadRaw = (res.end as jest.Mock).mock.calls.at(-1)?.[0] as string;
    const payload = JSON.parse(payloadRaw);
    expect(payload.error).toBe("Response too large");
  });
});
