import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, parseOpenGraph } from "./og-parse.js";

const BASE = "https://example.com/article/42";

describe("decodeHtmlEntities", () => {
  it("decodes named, decimal, and hex entities", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &mdash; &quot;fun&quot;")).toBe(
      'Tom & Jerry — "fun"',
    );
    expect(decodeHtmlEntities("&#20013;&#25991;")).toBe("中文");
    expect(decodeHtmlEntities("&#x27;quoted&#x27;")).toBe("'quoted'");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeHtmlEntities("&unknownentity; stays")).toBe("&unknownentity; stays");
  });
});

describe("parseOpenGraph", () => {
  it("extracts the standard og tags", () => {
    const html = `<html><head>
      <meta property="og:title" content="Hello World" />
      <meta property="og:description" content="A page about things" />
      <meta property="og:image" content="https://cdn.example.com/cover.jpg" />
      <meta property="og:site_name" content="Example" />
    </head><body></body></html>`;
    expect(parseOpenGraph(html, BASE)).toEqual({
      title: "Hello World",
      description: "A page about things",
      imageUrl: "https://cdn.example.com/cover.jpg",
      siteName: "Example",
      iconUrl: null,
    });
  });

  it("handles name= variant, swapped attribute order, and single quotes", () => {
    const html = `
      <meta content="Swapped" property="og:title">
      <meta name='og:description' content='Single quoted'>
    `;
    const result = parseOpenGraph(html, BASE);
    expect(result.title).toBe("Swapped");
    expect(result.description).toBe("Single quoted");
  });

  it("first occurrence wins for duplicate og tags", () => {
    const html = `
      <meta property="og:title" content="First">
      <meta property="og:title" content="Second">
    `;
    expect(parseOpenGraph(html, BASE).title).toBe("First");
  });

  it("falls back to <title> and meta description", () => {
    const html = `<html><head>
      <title>  Fallback   Title </title>
      <meta name="description" content="Fallback description">
    </head></html>`;
    const result = parseOpenGraph(html, BASE);
    expect(result.title).toBe("Fallback Title");
    expect(result.description).toBe("Fallback description");
  });

  it("decodes entities and collapses whitespace in text fields", () => {
    const html = `<meta property="og:title" content="Q&amp;A:&#x20;What&#39;s
      new">`;
    expect(parseOpenGraph(html, BASE).title).toBe("Q&A: What's new");
  });

  it("resolves a relative og:image against the page URL", () => {
    const html = `<meta property="og:image" content="/img/cover.png">`;
    expect(parseOpenGraph(html, BASE).imageUrl).toBe("https://example.com/img/cover.png");
  });

  it("drops non-http og:image values", () => {
    const html = `<meta property="og:image" content="data:image/png;base64,AAAA">`;
    expect(parseOpenGraph(html, BASE).imageUrl).toBeNull();
  });

  it("returns nulls for a page with no usable metadata", () => {
    expect(parseOpenGraph("<html><body>plain</body></html>", BASE)).toEqual({
      title: null,
      description: null,
      imageUrl: null,
      siteName: null,
      iconUrl: null,
    });
  });

  it("extracts and resolves a favicon, preferring apple-touch-icon, skipping mask-icon", () => {
    const html = `<head>
      <link rel="mask-icon" href="/safari.svg" color="#000">
      <link rel="icon" type="image/png" href="/favicon-32.png">
      <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
    </head>`;
    expect(parseOpenGraph(html, BASE).iconUrl).toBe("https://cdn.example.com/touch.png");
  });

  it("falls back to a regular icon link and resolves relative hrefs", () => {
    const html = `<link rel="shortcut icon" href="/static/fav.ico">`;
    expect(parseOpenGraph(html, BASE).iconUrl).toBe("https://example.com/static/fav.ico");
  });

  it("returns null icon when only a mask-icon is present", () => {
    expect(parseOpenGraph(`<link rel="mask-icon" href="/m.svg">`, BASE).iconUrl).toBeNull();
  });

  it("falls back to twitter card tags when og is absent", () => {
    const html = `
      <meta name="twitter:title" content="TW Title">
      <meta name="twitter:description" content="TW Desc">
      <meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
    `;
    const r = parseOpenGraph(html, BASE);
    expect(r.title).toBe("TW Title");
    expect(r.description).toBe("TW Desc");
    expect(r.imageUrl).toBe("https://cdn.example.com/tw.jpg");
  });

  it("falls back to JSON-LD (headline/description/image, incl. @graph and ImageObject)", () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"NewsArticle","headline":"LD Headline","description":"LD Desc",
         "image":{"@type":"ImageObject","url":"https://cdn.example.com/ld.jpg"}}
      ]}
    </script>`;
    const r = parseOpenGraph(html, BASE);
    expect(r.title).toBe("LD Headline");
    expect(r.description).toBe("LD Desc");
    expect(r.imageUrl).toBe("https://cdn.example.com/ld.jpg");
  });

  it("prefers a body article-title over a generic <title> (QQ-style SPA shell)", () => {
    const html = `<head><title>搜索资讯页</title></head>
      <body><div class="article-wrapper"><div class="article-title">钉钉"两篇大作文"事件——离职副总裁万字长文</div></div></body>`;
    expect(parseOpenGraph(html, BASE).title).toBe('钉钉"两篇大作文"事件——离职副总裁万字长文');
  });

  it("prefers an <h1> over a generic <title>", () => {
    const html = `<title>Home</title><h1>The Real Headline</h1>`;
    expect(parseOpenGraph(html, BASE).title).toBe("The Real Headline");
  });

  it("extracts a cover image from inline JSON (extensionless, escaped slashes)", () => {
    const html = `<title>搜索资讯页</title>
      <script>window.__INFO__={"imgUrl":"http:\\/\\/qqpublic.qpic.cn\\/qq_public_cover\\/0\\/0-2342_op"}</script>`;
    expect(parseOpenGraph(html, BASE).imageUrl).toBe(
      "http://qqpublic.qpic.cn/qq_public_cover/0/0-2342_op",
    );
  });

  it("standard og tags still win over body/json fallbacks", () => {
    const html = `<meta property="og:title" content="OG Wins">
      <h1>Body H1</h1>
      <div class="article-title">Body Title</div>`;
    expect(parseOpenGraph(html, BASE).title).toBe("OG Wins");
  });

  it("does not throw on malformed or truncated HTML", () => {
    expect(() => parseOpenGraph(`<meta property="og:title" content="Trunc`, BASE)).not.toThrow();
    expect(() => parseOpenGraph("<<<>>><meta<meta>", BASE)).not.toThrow();
  });

  it("ignores empty content values", () => {
    const html = `<meta property="og:title" content="">
      <title>Real Title</title>`;
    // og:title 占位为空串 → cleanText 归 null,但 og map 已记录空串;回退逻辑应仍给出可用 title
    const result = parseOpenGraph(html, BASE);
    expect(result.title).toBe("Real Title");
  });
});
