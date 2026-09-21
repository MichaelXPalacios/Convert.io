import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  assertFetchableUrl,
  fetchPage,
  isPrivateAddress,
  MAX_BYTES,
  UrlPolicyError,
} from "../src/url-policy.js";

const rejects = async (url: string, why: string) => {
  await assert.rejects(
    () => assertFetchableUrl(url),
    (error: unknown) => error instanceof UrlPolicyError,
    why,
  );
};

describe("isPrivateAddress", () => {
  it("refuses the ranges that reach our own infrastructure", () => {
    for (const ip of [
      "127.0.0.1", // loopback
      "10.1.2.3", // private
      "172.16.0.1", // private
      "172.31.255.255", // private, top of range
      "192.168.1.1", // private
      "169.254.169.254", // cloud instance metadata
      "0.0.0.0", // this host
      "100.64.0.1", // carrier-grade NAT
      "224.0.0.1", // multicast
      "::1", // loopback
      "fc00::1", // unique local
      "fe80::1", // link-local
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped metadata
    ]) {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be refused`);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      assert.equal(isPrivateAddress(ip), false, `${ip} must be allowed`);
    }
  });

  it("refuses 172.15 and 172.32, which sit either side of the private block", () => {
    assert.equal(isPrivateAddress("172.15.0.1"), false);
    assert.equal(isPrivateAddress("172.32.0.1"), false);
  });

  it("refuses anything that is not an address at all", () => {
    assert.equal(isPrivateAddress("not-an-ip"), true);
    assert.equal(isPrivateAddress(""), true);
  });
});

describe("assertFetchableUrl", () => {
  it("refuses schemes that are not http or https", async () => {
    await rejects("file:///etc/passwd", "file: would read our own disk");
    await rejects("data:text/html,<h1>hi", "data: is not a page to audit");
    await rejects("ftp://example.com/x", "ftp is not supported");
    await rejects("gopher://example.com/", "gopher is a classic SSRF vector");
  });

  it("refuses credentials embedded in the URL", async () => {
    await rejects("http://user:pass@example.com/", "credentials are a laundering trick");
  });

  it("refuses literal private addresses without needing DNS", async () => {
    await rejects("http://127.0.0.1/", "loopback");
    await rejects("http://169.254.169.254/latest/meta-data/", "cloud metadata");
    await rejects("http://10.0.0.1/", "private");
    await rejects("http://[::1]:8080/", "IPv6 loopback in brackets");
  });

  it("refuses a hostname that resolves somewhere private", async () => {
    // localhost resolves without a network, which is what makes this testable.
    await rejects("http://localhost:3000/", "localhost resolves to loopback");
  });

  it("refuses a URL that is not a URL", async () => {
    await rejects("not a url", "unparseable");
  });

  it("accepts a public literal address", async () => {
    const url = await assertFetchableUrl("https://8.8.8.8/page");
    assert.equal(url.hostname, "8.8.8.8");
  });
});

// ---------------------------------------------------------------------------
// fetchPage, with the network injected
// ---------------------------------------------------------------------------

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...headers },
  });

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe("fetchPage", () => {
  it("returns the page for a public URL", async () => {
    const page = await fetchPage("https://8.8.8.8/", async () => html("<h1>hello</h1>"));
    assert.equal(page.html, "<h1>hello</h1>");
    assert.equal(page.truncated, false);
  });

  it("re-checks the destination of every redirect", async () => {
    // The attack: a public host answers 302 pointing at cloud metadata. fetch
    // would follow it happily; the policy must not.
    const hostile = async (url: string) =>
      url.startsWith("https://8.8.8.8")
        ? redirect("http://169.254.169.254/latest/meta-data/")
        : html("SECRET CREDENTIALS");

    await assert.rejects(
      () => fetchPage("https://8.8.8.8/", hostile as unknown as typeof fetch),
      (error: unknown) =>
        error instanceof UrlPolicyError && /not publicly routable/.test(error.message),
      "a redirect into link-local space must be refused",
    );
  });

  it("follows a redirect that stays public", async () => {
    const hop = async (url: string) =>
      url === "https://8.8.8.8/" ? redirect("https://1.1.1.1/final") : html("<h1>arrived</h1>");

    const page = await fetchPage("https://8.8.8.8/", hop as unknown as typeof fetch);
    assert.equal(page.url, "https://1.1.1.1/final");
    assert.equal(page.html, "<h1>arrived</h1>");
  });

  it("gives up rather than looping forever", async () => {
    const loop = async () => redirect("https://1.1.1.1/again");
    await assert.rejects(
      () => fetchPage("https://8.8.8.8/", loop as unknown as typeof fetch),
      (error: unknown) =>
        error instanceof UrlPolicyError && /too many redirects/.test(error.message),
    );
  });

  it("refuses a content-length larger than the cap before reading a byte", async () => {
    const huge = async () =>
      new Response("x", {
        status: 200,
        headers: { "content-type": "text/html", "content-length": String(MAX_BYTES + 1) },
      });

    await assert.rejects(
      () => fetchPage("https://8.8.8.8/", huge as unknown as typeof fetch),
      (error: unknown) => error instanceof UrlPolicyError && error.status === 413,
    );
  });

  it("caps a body that lies about its length", async () => {
    // Content-Length is a claim. A body that exceeds the cap anyway must be
    // truncated rather than read to the end, because the billing risk is in
    // the tokens, not the bytes.
    const lying = async () =>
      new Response("a".repeat(MAX_BYTES + 5_000), {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const page = await fetchPage("https://8.8.8.8/", lying as unknown as typeof fetch);
    assert.equal(page.truncated, true);
    assert.ok(page.html.length <= MAX_BYTES, "must not exceed the cap");
  });

  it("refuses something that is not a page", async () => {
    const pdf = async () =>
      new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } });

    await assert.rejects(
      () => fetchPage("https://8.8.8.8/", pdf as unknown as typeof fetch),
      (error: unknown) => error instanceof UrlPolicyError && error.status === 415,
    );
  });

  it("reports an upstream failure as a gateway error, not a client error", async () => {
    const boom = async () => new Response("nope", { status: 500 });
    await assert.rejects(
      () => fetchPage("https://8.8.8.8/", boom as unknown as typeof fetch),
      (error: unknown) => error instanceof UrlPolicyError && error.status === 502,
    );
  });
});
