import { describe, expect, it } from "@jest/globals";
import { classifyIp } from "./ipLocation.ts";

describe("classifyIp", () => {
  it("labels private IPv4 ranges as local network", () => {
    expect(classifyIp("192.168.1.5").label).toBe("Local network");
    expect(classifyIp("10.0.0.42").label).toBe("Local network");
    expect(classifyIp("172.20.3.1").label).toBe("Local network");
    expect(classifyIp("127.0.0.1").label).toBe("Local network");
    expect(classifyIp("100.64.0.5").label).toBe("Local network"); // CGNAT
  });

  it("labels public IPv4 addresses as internet", () => {
    expect(classifyIp("203.0.113.7").label).toBe("Internet");
    expect(classifyIp("8.8.8.8").label).toBe("Internet");
  });

  it("labels IPv6 loopback and unique-local ranges as local network", () => {
    expect(classifyIp("::1").label).toBe("Local network");
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
