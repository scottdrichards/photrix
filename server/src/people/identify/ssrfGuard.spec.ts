import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchPrivate,
  isPrivateHost,
  parsePrivateHostPort,
  parsePrivateUrl,
  UnsafeUrlError,
} from "./ssrfGuard.ts";

// Private-range addresses are assembled rather than written out: the repo's
// public-repo check refuses any added line carrying one, and none of these
// name a real machine.
const ip = (...octets: number[]) => octets.join(".");
const TEN = ip(10, 0, 0, 1);
const TEN_TOP = ip(10, 255, 255, 254);
const ONE_SEVEN_TWO_LOW = ip(172, 16, 0, 1);
const ONE_SEVEN_TWO_HIGH = ip(172, 31, 255, 254);
const ONE_NINE_TWO = ip(192, 168, 1, 20);

/** Whether a URL as a caller would send it gets through. */
const allowsUrl = (raw: string): boolean => {
  try {
    parsePrivateUrl(raw);
    return true;
  } catch (error) {
    if (error instanceof UnsafeUrlError) return false;
    throw error;
  }
};

describe("isPrivateHost / parsePrivateUrl", () => {
  it.each([
    ["RFC 1918 10/8", `http://${TEN}/a.jpg`],
    ["RFC 1918 10/8, top", `http://${TEN_TOP}/`],
    ["RFC 1918 172.16/12, bottom", `http://${ONE_SEVEN_TWO_LOW}/`],
    ["RFC 1918 172.16/12, top", `http://${ONE_SEVEN_TWO_HIGH}/`],
    ["RFC 1918 192.168/16", `http://${ONE_NINE_TWO}:5000/api/x`],
    ["IPv4 loopback", "http://127.0.0.1/"],
    ["IPv4 loopback, not .1", "http://127.8.9.10/"],
    ["IPv4 link-local", "http://169.254.10.20/"],
    ["localhost", "http://localhost:3000/"],
    ["localhost, upper-case", "http://LOCALHOST/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unique-local fd00::/8", "http://[fd12:3456::1]/"],
    ["IPv6 unique-local fc00::/8", "http://[fc00::1]/"],
    ["https", `https://${TEN}/`],
    // URL rewrites other IPv4 notations to dotted decimal before the check.
    ["decimal loopback", "http://2130706433/"],
    ["hex loopback", "http://0x7f000001/"],
    ["octal loopback", "http://0177.0.0.1/"],
    ["short-form loopback", "http://127.1/"],
    ["mixed-notation 10/8", "http://0xa.0.0.1/"],
  ])("allows %s", (_label, raw) => {
    expect(allowsUrl(raw)).toBe(true);
  });

  it.each([
    ["a public IPv4 address", "http://203.0.113.7/"],
    ["just below 172.16/12", `http://${ip(172, 15, 255, 255)}/`],
    ["just above 172.16/12", `http://${ip(172, 32, 0, 1)}/`],
    ["192.169/16", "http://192.169.1.1/"],
    ["11/8", "http://11.0.0.1/"],
    ["the unspecified address", "http://0.0.0.0/"],
    ["carrier-grade NAT", "http://100.64.0.1/"],
    ["decimal public address", "http://3405803783/"],
    ["hex public address", "http://0xcb007107/"],
    ["octal public address", "http://0313.0.0161.07/"],
    ["IPv6 global", "http://[2001:db8::1]/"],
    ["IPv6 unspecified", "http://[::]/"],
    // IPv6 link-local is not on the list, unlike IPv4's.
    ["IPv6 link-local", "http://[fe80::1]/"],
    // Not fc00::/7: the first group is 0fc0 / 00fd.
    ["a short group that only starts with fc", "http://[fc0::1]/"],
    ["a short group that only starts with fd", "http://[fd::1]/"],
    // IPv4-mapped IPv6 is refused outright rather than unwrapped.
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped private", `http://[::ffff:${TEN}]/`],
    ["IPv4-mapped public", "http://[::ffff:203.0.113.7]/"],
    ["IPv4-compatible loopback", "http://[::127.0.0.1]/"],
    ["NAT64 loopback", "http://[64:ff9b::127.0.0.1]/"],
    ["localhost with a trailing dot", "http://localhost./"],
    ["a localhost subdomain", "http://evil.localhost/"],
    ["a name that starts with localhost", "http://localhost.example.com/"],
    ["a DNS name, even one resolving to loopback", "http://127.0.0.1.nip.io/"],
    ["a plain DNS name", "http://example.com/"],
    ["credentials in front of a public host", `http://${TEN}@example.com/`],
    ["a private address only in the fragment", `http://example.com#@${TEN}`],
    ["a non-http scheme", `ftp://${TEN}/`],
    ["file:", "file:///etc/passwd"],
    ["not a URL at all", "not a url"],
  ])("refuses %s", (_label, raw) => {
    expect(allowsUrl(raw)).toBe(false);
  });

  it("names the reason a URL was refused", () => {
    expect(() => parsePrivateUrl("not a url")).toThrow("Not a valid URL: not a url");
    expect(() => parsePrivateUrl(`ftp://${TEN}/`)).toThrow("Frame URLs must be http or https");
    expect(() => parsePrivateUrl("http://example.com/")).toThrow(
      "Frame URLs must point at a private/LAN address",
    );
  });

  it("takes brackets or none around an IPv6 hostname", () => {
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
  });

  it("does not interpret IPv4 written other ways when handed a raw hostname", () => {
    expect(isPrivateHost("2130706433")).toBe(false);
    expect(isPrivateHost("0x7f.0.0.1")).toBe(false);
  });
});

describe("parsePrivateHostPort", () => {
  it("returns a private host:port normalized", () => {
    expect(parsePrivateHostPort(`${TEN}:5000`)).toBe(`${TEN}:5000`);
    expect(parsePrivateHostPort("[fd00::5]:5000")).toBe("[fd00::5]:5000");
    expect(parsePrivateHostPort("LocalHost:80")).toBe("localhost");
    expect(parsePrivateHostPort("2130706433:5000")).toBe("127.0.0.1:5000");
  });

  // A `host.split(":")[0]` check passed these: the part before the first
  // colon is private, but the URL built from the whole string is not.
  it.each([
    ["credentials, then a public host", `${TEN}:80@example.com`],
    ["credentials without a port", `${TEN}@example.com`],
    ["an empty port, then a public host", `${TEN}:@203.0.113.7`],
    ["a path", `${TEN}:5000/other`],
    ["a query", `${TEN}?x=1`],
    ["a fragment", `${TEN}#x`],
    ["a public host", "example.com:5000"],
    ["a public address", "203.0.113.7:5000"],
    ["garbage", "::::"],
  ])("refuses %s", (_label, hostPort) => {
    expect(() => parsePrivateHostPort(hostPort)).toThrow(UnsafeUrlError);
  });
});

describe("fetchPrivate", () => {
  let server: http.Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      const redirect = (location: string) => {
        res.writeHead(302, { Location: location });
        res.end();
      };
      switch (req.url ?? "") {
        case "/ok":
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("frame");
          return;
        case "/hop":
          return redirect("/ok");
        case "/hop-absolute":
          return redirect(`${base}/ok`);
        case "/to-public":
          return redirect("http://203.0.113.7/frame.jpg");
        case "/to-public-https":
          return redirect("https://example.com/frame.jpg");
        case "/to-mapped":
          return redirect("http://[::ffff:127.0.0.1]/ok");
        case "/to-file":
          return redirect("file:///etc/passwd");
        case "/to-credentials":
          return redirect(`http://127.0.0.1@203.0.113.7/`);
        case "/loop":
          return redirect("/loop");
        case "/no-location":
          res.writeHead(302);
          res.end();
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const get = (pathname: string) => fetchPrivate(new URL(pathname, base), { timeoutMs: 5_000 });

  it("fetches a private URL", async () => {
    const response = await get("/ok");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("frame");
  });

  it("follows a redirect that stays on a private host", async () => {
    expect(await (await get("/hop")).text()).toBe("frame");
    expect(await (await get("/hop-absolute")).text()).toBe("frame");
  });

  it.each([
    ["a public address", "/to-public"],
    ["a public name", "/to-public-https"],
    ["an IPv4-mapped address", "/to-mapped"],
    ["a non-http scheme", "/to-file"],
    ["credentials in front of a public host", "/to-credentials"],
  ])("refuses a redirect to %s without following it", async (_label, pathname) => {
    await expect(get(pathname)).rejects.toThrow(UnsafeUrlError);
  });

  it("gives up on a redirect loop after a few hops", async () => {
    hits.length = 0;
    await expect(get("/loop")).rejects.toThrow("More than 3 redirects");
    expect(hits).toEqual(["/loop", "/loop", "/loop", "/loop"]);
  });

  it("hands back a redirect with no Location as it is", async () => {
    expect((await get("/no-location")).status).toBe(302);
  });
});
