import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { createIpGeolocation, formatPlace } from "./ipGeolocation.ts";


const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const fakeFetch = (handler: (url: string) => Response | Promise<Response>) =>
  jest.fn(async (url: string, _init?: RequestInit) => handler(url));

describe("formatPlace", () => {
  it("joins the parts that are present", () => {
    expect(formatPlace("Seattle", "Washington", "United States")).toBe(
      "Seattle, Washington, United States",
    );
    expect(formatPlace(null, "Bavaria", "Germany")).toBe("Bavaria, Germany");
    expect(formatPlace(null, undefined, null)).toBeNull();
  });

  it("drops a repeated part", () => {
    expect(formatPlace("Singapore", "Singapore", "Singapore")).toBe("Singapore");
  });
});

describe("createIpGeolocation", () => {
  afterEach(() => {
    delete process.env.PHOTRIX_IP_LOCATION;
  });

  it("names the place from ipapi.co, spelling out the country", async () => {
    const fetchImpl = fakeFetch(() =>
      json({ ip: "203.0.113.9", city: "Portland", region: "Oregon", country: "US" }),
    );
    const { placesFor } = createIpGeolocation({ fetchImpl });
    const places = await placesFor(["203.0.113.9"]);
    expect(places.get("203.0.113.9")).toBe("Portland, Oregon, United States");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("ipapi.co/203.0.113.9");
  });

  it("prefers the full country name when the answer has one", async () => {
    const fetchImpl = fakeFetch(() =>
      json({ city: "Lyon", region: "Auvergne-Rhone-Alpes", country: "FR", country_name: "France" }),
    );
    const { placesFor } = createIpGeolocation({ fetchImpl });
    expect((await placesFor(["198.51.100.4"])).get("198.51.100.4")).toBe(
      "Lyon, Auvergne-Rhone-Alpes, France",
    );
  });

  it("falls back to the next provider when one fails", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("first.test")) throw new Error("ECONNRESET");
      return json({ city: "Lyon" });
    });
    const { placesFor } = createIpGeolocation({
      fetchImpl,
      providers: [
        { name: "first", url: (ip) => `https://first.test/${ip}`, parse: () => "never" },
        { name: "second", url: (ip) => `https://second.test/${ip}`, parse: () => "Lyon" },
      ],
    });
    expect((await placesFor(["198.51.100.4"])).get("198.51.100.4")).toBe("Lyon");
  });

  it("treats an error body, a rate limit or a network error as no answer", async () => {
    for (const handler of [
      () => json({ error: true, reason: "RateLimited" }),
      () => json({ error: true, reason: "RateLimited" }, 429),
      () => {
        throw new Error("ECONNRESET");
      },
    ]) {
      const { placesFor } = createIpGeolocation({ fetchImpl: fakeFetch(handler) });
      expect((await placesFor(["198.51.100.4"])).size).toBe(0);
    }
  });

  it("caches answers, and failures for a shorter time", async () => {
    let clock = 0;
    let up = false;
    const fetchImpl = fakeFetch(() =>
      up ? json({ city: "Austin", region: "Texas", country: "US" }) : json({}, 503),
    );
    const { placesFor } = createIpGeolocation({ fetchImpl, now: () => clock });

    expect((await placesFor(["203.0.113.9"])).size).toBe(0);
    const callsAfterFailure = fetchImpl.mock.calls.length;
    up = true;
    expect((await placesFor(["203.0.113.9"])).size).toBe(0); // still the cached failure
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFailure);

    clock += 61 * 60_000; // the failure has expired
    expect((await placesFor(["203.0.113.9"])).get("203.0.113.9")).toBe(
      "Austin, Texas, United States",
    );
    const callsAfterSuccess = fetchImpl.mock.calls.length;
    clock += 24 * 60 * 60_000;
    await placesFor(["203.0.113.9"]);
    expect(fetchImpl.mock.calls.length).toBe(callsAfterSuccess);
  });

  it("asks once for an address listed twice", async () => {
    const fetchImpl = fakeFetch(() => json({ city: "Oslo", country: "NO" }));
    const { placesFor } = createIpGeolocation({ fetchImpl });
    await placesFor(["203.0.113.9", "203.0.113.9"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("doesn't hold the list for a slow lookup, and keeps its answer for next time", async () => {
    let answer: (r: Response) => void = () => {};
    const fetchImpl = fakeFetch(
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    const { placesFor } = createIpGeolocation({ fetchImpl });
    const started = Date.now();
    expect((await placesFor(["203.0.113.9"], 50)).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    answer(json({ city: "Denver", region: "Colorado", country: "US" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await placesFor(["203.0.113.9"], 50)).get("203.0.113.9")).toBe(
      "Denver, Colorado, United States",
    );
  });

  it("looks nothing up when turned off", async () => {
    process.env.PHOTRIX_IP_LOCATION = "off";
    const fetchImpl = fakeFetch(() => json({ city: "Nowhere" }));
    const { placesFor } = createIpGeolocation({ fetchImpl });
    expect((await placesFor(["203.0.113.9"])).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
