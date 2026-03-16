import { describe, expect, it, jest } from "@jest/globals";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { facesRequestHandler } from "./facesRequestHandler.ts";

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

const createRequest = (url: string, method: string = "GET", body?: unknown) => {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf-8")];

  return {
    url,
    method,
    headers: { host: "localhost" },
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>;
};

describe("facesRequestHandler", () => {
  it("returns face queue with parsed filters and stable payload fields", async () => {
    const { res, getBody } = createMockResponse();
    const queryFaceQueue = jest.fn(() => ({
      items: [
        {
          faceId: "f1",
          relativePath: "/trip/a.jpg",
          fileName: "a.jpg",
          dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          person: null,
          status: "unverified",
          source: "auto-detected",
          quality: { overall: 0.82 },
          thumbnail: { preferredHeight: 224, cropVersion: "v1" },
          suggestion: {
            personId: "person-1",
            confidence: 0.91,
            modelVersion: "seed-v1",
          },
        },
      ],
      total: 1,
      page: 2,
      pageSize: 10,
    }));

    await facesRequestHandler(
      createRequest(
        "/api/faces/queue?status=unverified&personId=person-1&page=2&pageSize=10&minConfidence=0.8",
      ),
      res,
      {
        database: { queryFaceQueue } as unknown as IndexDatabase,
      },
    );

    expect(queryFaceQueue).toHaveBeenCalledWith({
      status: "unverified",
      personId: "person-1",
      page: 2,
      pageSize: 10,
      minConfidence: 0.8,
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      items: [
        {
          faceId: "f1",
          relativePath: "/trip/a.jpg",
          fileName: "a.jpg",
          dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          person: null,
          status: "unverified",
          source: "auto-detected",
          quality: { overall: 0.82 },
          thumbnail: { preferredHeight: 224, cropVersion: "v1" },
          suggestion: {
            personId: "person-1",
            confidence: 0.91,
            modelVersion: "seed-v1",
          },
        },
      ],
      total: 1,
      page: 2,
      pageSize: 10,
    });
  });

  it("returns 400 for invalid status", async () => {
    const { res, getBody } = createMockResponse();

    await facesRequestHandler(createRequest("/api/faces/queue?status=bad"), res, {
      database: {} as IndexDatabase,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(400);
    expect(JSON.parse(getBody())).toEqual({ error: "Invalid status" });
  });

  it("returns people summary", async () => {
    const { res, getBody } = createMockResponse();
    const queryFacePeople = jest.fn(() => [
      {
        id: "p1",
        name: "Sam",
        count: 3,
        representativeFace: {
          faceId: "face-1",
          relativePath: "/trip/a.jpg",
          fileName: "a.jpg",
          dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          thumbnail: { preferredHeight: 224, cropVersion: "v1" },
        },
      },
    ]);

    await facesRequestHandler(createRequest("/api/faces/people"), res, {
      database: { queryFacePeople } as unknown as IndexDatabase,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      people: [
        {
          id: "p1",
          name: "Sam",
          count: 3,
          representativeFace: {
            faceId: "face-1",
            relativePath: "/trip/a.jpg",
            fileName: "a.jpg",
            dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            thumbnail: { preferredHeight: 224, cropVersion: "v1" },
          },
        },
      ],
    });
  });

  it("passes path and includeSubfolders to queue query", async () => {
    const { res } = createMockResponse();
    const queryFaceQueue = jest.fn(() => ({ items: [], total: 0, page: 1, pageSize: 10 }));

    await facesRequestHandler(
      createRequest("/api/faces/queue?path=trip%2F&includeSubfolders=true"),
      res,
      { database: { queryFaceQueue } as unknown as IndexDatabase },
    );

    expect(queryFaceQueue).toHaveBeenCalledWith(
      expect.objectContaining({ path: "trip/", includeSubfolders: true }),
    );
  });

  it("passes path and includeSubfolders to people query", async () => {
    const { res } = createMockResponse();
    const queryFacePeople = jest.fn(() => []);

    await facesRequestHandler(
      createRequest("/api/faces/people?path=trip%2F&includeSubfolders=false"),
      res,
      { database: { queryFacePeople } as unknown as IndexDatabase },
    );

    expect(queryFacePeople).toHaveBeenCalledWith({ path: "trip/", includeSubfolders: false });
  });

  it("returns close matches for a face", async () => {
    const { res, getBody } = createMockResponse();
    const queryFaceMatches = jest.fn(() => [
      {
        faceId: "match-1",
        relativePath: "/trip/b.jpg",
        fileName: "b.jpg",
        dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        confidence: 0.9321,
        person: null,
        status: "unverified",
      },
    ]);

    await facesRequestHandler(createRequest("/api/faces/face-1/matches?limit=5"), res, {
      database: { queryFaceMatches } as unknown as IndexDatabase,
    });

    expect(queryFaceMatches).toHaveBeenCalledWith({ faceId: "face-1", limit: 5 });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      items: [
        {
          faceId: "match-1",
          relativePath: "/trip/b.jpg",
          fileName: "b.jpg",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          confidence: 0.9321,
          person: null,
          status: "unverified",
        },
      ],
    });
  });

  it("returns profile-based suggestions for a person", async () => {
    const { res, getBody } = createMockResponse();
    const queryPersonFaceSuggestions = jest.fn(() => [
      {
        faceId: "candidate-1",
        relativePath: "/trip/c.jpg",
        fileName: "c.jpg",
        dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        confidence: 0.881,
        person: null,
        status: "unverified",
      },
    ]);

    await facesRequestHandler(
      createRequest("/api/faces/people/name%3Asam/suggestions?limit=7"),
      res,
      {
        database: { queryPersonFaceSuggestions } as unknown as IndexDatabase,
      },
    );

    expect(queryPersonFaceSuggestions).toHaveBeenCalledWith({
      personId: "name:sam",
      limit: 7,
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({
      items: [
        {
          faceId: "candidate-1",
          relativePath: "/trip/c.jpg",
          fileName: "c.jpg",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          confidence: 0.881,
          person: null,
          status: "unverified",
        },
      ],
    });
  });

  it("accepts a suggestion", async () => {
    const { res, getBody } = createMockResponse();
    const acceptFaceSuggestion = jest.fn(() => true);

    await facesRequestHandler(
      createRequest("/api/faces/f-1/accept", "POST", { personId: "person-1" }),
      res,
      {
        database: { acceptFaceSuggestion } as unknown as IndexDatabase,
      },
    );

    expect(acceptFaceSuggestion).toHaveBeenCalledWith({
      faceId: "f-1",
      personId: "person-1",
      personName: undefined,
      reviewer: undefined,
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({ ok: true, action: "accept", faceId: "f-1" });
  });

  it("rejects a suggestion", async () => {
    const { res, getBody } = createMockResponse();
    const rejectFaceSuggestion = jest.fn(() => true);

    await facesRequestHandler(
      createRequest("/api/faces/f-1/reject", "POST", { personId: "person-1" }),
      res,
      {
        database: { rejectFaceSuggestion } as unknown as IndexDatabase,
      },
    );

    expect(rejectFaceSuggestion).toHaveBeenCalledWith({
      faceId: "f-1",
      personId: "person-1",
      reviewer: undefined,
    });
    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(200);
    expect(JSON.parse(getBody())).toEqual({ ok: true, action: "reject", faceId: "f-1" });
  });

  it("requires personId or personName for accept", async () => {
    const { res, getBody } = createMockResponse();

    await facesRequestHandler(createRequest("/api/faces/f-1/accept", "POST", {}), res, {
      database: {} as IndexDatabase,
    });

    expect((res.writeHead as jest.Mock).mock.calls[0]?.[0]).toBe(400);
    expect(JSON.parse(getBody())).toEqual({
      error: "personId or personName is required",
    });
  });
});
