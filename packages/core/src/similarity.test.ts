import { describe, expect, it } from "vitest";
import { findSimilarityGroups } from "./similarity.js";
import { item } from "./test-helpers.js";

describe("findSimilarityGroups", () => {
  it("matches username and email identities after trimming and ignoring case", () => {
    const groups = findSimilarityGroups([
      item({
        id: "private:github",
        title: "Personal GitHub",
        urls: ["https://github.com/login?from=old#top"],
        usernames: ["  Alice@Example.com  "],
      }),
      item({
        id: "work:github",
        title: "Work GitHub",
        urls: ["https://github.com/login/?from=new#bottom"],
        comparableFields: [{ label: "Email", kind: "email", normalizedValue: "alice@example.COM" }],
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: expect.stringMatching(/^sim_/),
      itemIds: expect.arrayContaining(["private:github", "work:github"]),
      reasons: [{
        rule: "account-identity-url",
        label: "账号身份相同且 URL 相似",
        itemIds: ["private:github", "work:github"],
      }],
    });
  });

  it("uses title as an identity regardless of usernames, category, or credentials", () => {
    const groups = findSimilarityGroups([
      item({
        id: "private:passkey",
        title: "  GitHub  ",
        urls: ["https://github.com/login"],
        usernames: [],
        hasPasskey: false,
      }),
      item({
        id: "work:password",
        title: "github",
        category: "api-credential",
        urls: ["https://github.com/login/"],
        usernames: ["another-account"],
        hasPassword: true,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].reasons.map((reason) => reason.rule)).toEqual(["title-url"]);
  });

  it("matches URL scheme, hostname, effective port, and path while ignoring query and hash", () => {
    const groups = findSimilarityGroups([
      item({
        id: "a",
        title: "A",
        urls: ["https://EXAMPLE.com:443/login?one=1#top"],
        usernames: ["alice"],
      }),
      item({
        id: "b",
        title: "B",
        urls: ["https://example.com/login/?two=2#bottom"],
        usernames: ["ALICE"],
      }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it.each([
    ["https://example.com/login", "http://example.com/login"],
    ["https://example.com/login", "https://www.example.com/login"],
    ["https://example.com/login", "https://sub.example.com/login"],
    ["https://example.com:8443/login", "https://example.com/login"],
    ["https://example.com/login", "https://example.com/account"],
    ["https://example.com/login", "https://example.com/login//"],
  ])("does not match distinct parsed URLs: %s and %s", (leftUrl, rightUrl) => {
    const groups = findSimilarityGroups([
      item({ id: "a", title: "A", urls: [leftUrl], usernames: ["alice"] }),
      item({ id: "b", title: "B", urls: [rightUrl], usernames: ["alice"] }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it("falls back to trimmed case-insensitive equality for invalid URLs", () => {
    const matching = findSimilarityGroups([
      item({ id: "a", title: "A", urls: ["  NOT A URL  "], usernames: ["alice"] }),
      item({ id: "b", title: "B", urls: ["not a url"], usernames: ["alice"] }),
    ]);
    const differentQuery = findSimilarityGroups([
      item({ id: "a", title: "A", urls: ["invalid address?one=1"], usernames: ["alice"] }),
      item({ id: "b", title: "B", urls: ["invalid address?one=2"], usernames: ["alice"] }),
    ]);
    const hostlessScheme = findSimilarityGroups([
      item({ id: "a", title: "A", urls: ["CUSTOM:Address"], usernames: ["alice"] }),
      item({ id: "b", title: "B", urls: ["custom:address"], usernames: ["alice"] }),
    ]);

    expect(matching).toHaveLength(1);
    expect(differentQuery).toHaveLength(0);
    expect(hostlessScheme).toHaveLength(1);
  });

  it("matches when any URL pair and any explicit identity pair intersect", () => {
    const groups = findSimilarityGroups([
      item({
        id: "a",
        title: "A",
        urls: ["https://unrelated.example/a", "https://example.com/login"],
        usernames: ["first", "shared"],
      }),
      item({
        id: "b",
        title: "B",
        urls: ["https://example.com/login/", "https://unrelated.example/b"],
        usernames: ["shared"],
      }),
    ]);

    expect(groups).toHaveLength(1);
  });

  it("uses connected components to combine transitive similarity relationships", () => {
    const groups = findSimilarityGroups([
      item({ id: "a", title: "GitHub", urls: ["https://github.com/login"], usernames: [] }),
      item({ id: "b", title: "github", urls: ["https://github.com/login/"], usernames: ["alice"] }),
      item({ id: "c", title: "Alice account", urls: ["https://github.com/login?source=import"], usernames: ["ALICE"] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].itemIds).toHaveLength(3);
    expect(groups[0].reasons.map((reason) => reason.rule)).toEqual(expect.arrayContaining(["title-url", "account-identity-url"]));
  });

  it("does not group without both identity and URL evidence", () => {
    const groups = findSimilarityGroups([
      item({ id: "same-title-no-url-a", title: "Same", urls: [], usernames: [] }),
      item({ id: "same-title-no-url-b", title: "same", urls: [], usernames: [] }),
      item({ id: "same-url-no-identity-a", title: "A", urls: ["https://example.com/login"], usernames: [] }),
      item({ id: "same-url-no-identity-b", title: "B", urls: ["https://example.com/login"], usernames: [] }),
      item({ id: "same-identity-different-url-a", title: "C", urls: ["https://example.com/a"], usernames: ["alice"] }),
      item({ id: "same-identity-different-url-b", title: "D", urls: ["https://example.com/b"], usernames: ["alice"] }),
    ]);

    expect(groups).toHaveLength(0);
  });

  it("does not emit single-item quality or deletion suggestions", () => {
    const groups = findSimilarityGroups([
      item({ id: "incomplete", title: "Incomplete", urls: ["https://example.com"], usernames: [] }),
    ]);

    expect(groups).toHaveLength(0);
  });
});
