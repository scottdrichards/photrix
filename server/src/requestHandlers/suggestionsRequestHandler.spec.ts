import { describe, expect, it, jest } from "@jest/globals";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { suggestionsRequestHandler } from "./suggestionsRequestHandler.ts";

const createMockResponse = () => {
  let body = "";

  const res = {
    writeHead: jest.fn(),
    end: jest.fn((chunk?: string) => {
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

describe("suggestionsRequestHandler", () => {
  it("returns 400 for invalid field", async () => {
    const { res, getBody } = createMockResponse();

    await suggestionsRequestHandler(
      {
        url: "/api/suggestions?field=invalid&q=ca",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(400);
    expect(JSON.parse(getBody())).toEqual({ error: "Invalid field" });
  });

  it("returns context-aware suggestions when q is blank", async () => {
    const { res, getBody } = createMockResponse();
    const queryFieldSuggestions = jest.fn(() => ["Canon EOS R6"]);

    await suggestionsRequestHandler(
      {
        url: "/api/suggestions?field=tags&q=   ",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: { queryFieldSuggestions } as unknown as IndexDatabase,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({ suggestions: ["Canon EOS R6"] });
    expect(queryFieldSuggestions).toHaveBeenCalledWith({
      field: "tags",
      search: "",
      filter: {},
      limit: 8,
    });
  });

  it("passes parsed query options to database and returns suggestions", async () => {
    const { res, getBody } = createMockResponse();
    const queryFieldSuggestions = jest.fn(() => ["Canon", "Canon EOS"]);
    const filter = { cameraModel: { includes: "R6" } };

    await suggestionsRequestHandler(
      {
        url: `/api/suggestions?field=cameraMake&q=can&path=albums/2025&includeSubfolders=true&limit=5&filter=${encodeURIComponent(JSON.stringify(filter))}`,
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: { queryFieldSuggestions } as unknown as IndexDatabase,
      },
    );

    expect(queryFieldSuggestions).toHaveBeenCalledWith({
      field: "cameraMake",
      search: "can",
      filter: {
        operation: "and",
        conditions: [
          { folder: { folder: "albums/2025", recursive: true } },
          filter,
        ],
      },
      limit: 5,
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({ suggestions: ["Canon", "Canon EOS"] });
  });

  it("uses count-ranked suggestions when includeCounts=true", async () => {
    const { res, getBody } = createMockResponse();
    const queryFieldSuggestionsWithCounts = jest.fn(() => [
      { value: "Sam", count: 14 },
      { value: "Taylor", count: 9 },
    ]);

    await suggestionsRequestHandler(
      {
        url: "/api/suggestions?field=personInImage&q=&includeCounts=true&limit=5",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {
          queryFieldSuggestionsWithCounts,
        } as unknown as IndexDatabase,
      },
    );

    expect(queryFieldSuggestionsWithCounts).toHaveBeenCalledWith({
      field: "personInImage",
      search: "",
      filter: {},
      limit: 5,
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      suggestions: [
        { value: "Sam", count: 14 },
        { value: "Taylor", count: 9 },
      ],
    });
  });

  it("supports rating count suggestions", async () => {
    const { res, getBody } = createMockResponse();
    const queryFieldSuggestionsWithCounts = jest.fn(() => [
      { value: "5", count: 12 },
      { value: "4", count: 8 },
    ]);

    await suggestionsRequestHandler(
      {
        url: "/api/suggestions?field=rating&q=&includeCounts=true&limit=5",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {
          queryFieldSuggestionsWithCounts,
        } as unknown as IndexDatabase,
      },
    );

    expect(queryFieldSuggestionsWithCounts).toHaveBeenCalledWith({
      field: "rating",
      search: "",
      filter: {},
      limit: 5,
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      suggestions: [
        { value: "5", count: 12 },
        { value: "4", count: 8 },
      ],
    });
  });

  it("returns 400 for invalid JSON filter", async () => {
    const { res, getBody } = createMockResponse();

    await suggestionsRequestHandler(
      {
        url: "/api/suggestions?field=tags&q=ca&filter=%7Bbad",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(400);
    const body = JSON.parse(getBody());
    expect(body.error).toBe("Invalid suggestions query");
    expect(typeof body.message).toBe("string");
  });
});
