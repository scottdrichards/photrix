import { describe, expect, it } from "@jest/globals";
import { classifyIp, compareSessionsForList } from "./ipLocation.ts";

describe("classifyIp", () => {
  it("labels private IPv4 ranges as local network", () => {
    expect(classifyIp("192.168.1.5").label).toBe("Local network");
    expect(classifyIp("10.0.0.42").label).toBe("Local network");
    expect(classifyIp("172.20.3.1").label).toBe("Local network");
    expect(classifyIp("100.64.0.5").label).toBe("Local network"); // CGNAT
  });

  it("labels public IPv4 addresses as internet", () => {
    expect(classifyIp("203.0.113.7").label).toBe("Internet");
    expect(classifyIp("8.8.8.8").label).toBe("Internet");
  });

  it("labels loopback as the server itself", () => {
    expect(classifyIp("127.0.0.1").label).toBe("This server");
    expect(classifyIp("::1").label).toBe("This server");
    expect(classifyIp("::ffff:127.0.0.1").label).toBe("This server");
  });

  it("labels IPv6 unique-local and link-local ranges as local network", () => {
    expect(classifyIp("fd12:3456:789a::1").label).toBe("Local network");
    expect(classifyIp("fe80::1").label).toBe("Local network");
  });

  it("labels public IPv6 addresses as internet", () => {
    expect(classifyIp("2001:4860:4860::8888").label).toBe("Internet");
  });

  it("handles IPv4-mapped IPv6 addresses", () => {
    expect(classifyIp("::ffff:192.168.1.5").label).toBe("Local network");
  });

  it("returns Unknown when there is no address", () => {
    expect(classifyIp(null)).toEqual({ ip: null, label: "Unknown" });
  });
});

describe("compareSessionsForList", () => {
  it("puts internet first, then local network, the server and unknown, newest first in each", () => {
    const sessions = [
      { id: "lan-old", location: "Local network", lastSeenAt: 1 },
      { id: "server", location: "This server", lastSeenAt: 9 },
      { id: "unknown", location: "Unknown", lastSeenAt: 10 },
      { id: "net-old", location: "Internet", lastSeenAt: 2 },
      { id: "lan-new", location: "Local network", lastSeenAt: 8 },
      { id: "net-new", location: "Internet", lastSeenAt: 5 },
    ];
    expect([...sessions].sort(compareSessionsForList).map((s) => s.id)).toEqual([
      "net-new",
      "net-old",
      "lan-new",
      "lan-old",
      "server",
      "unknown",
    ]);
  });
});
