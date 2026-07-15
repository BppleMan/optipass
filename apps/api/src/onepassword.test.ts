import type { ScanProgressEvent } from "@optimize-password/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMock = vi.hoisted(() => {
  class DesktopAuth {
    accountName: string;

    constructor(accountName: string) {
      this.accountName = accountName;
    }
  }

  return {
    createClient: vi.fn(),
    DesktopAuth
  };
});

const desktopAppMock = vi.hoisted(() => ({
  execFile: vi.fn()
}));

vi.mock("@1password/sdk", () => ({
  default: {
    createClient: sdkMock.createClient,
    DesktopAuth: sdkMock.DesktopAuth
  }
}));

vi.mock("node:child_process", () => ({
  execFile: desktopAppMock.execFile
}));

import { mapOnePasswordCategory, OnePasswordService } from "./onepassword.js";

function loginItem(id: string) {
  return {
    id,
    category: "Login",
    title: id,
    fields: [],
    websites: [],
    tags: []
  };
}

describe("mapOnePasswordCategory", () => {
  it("maps all SDK item categories used by 1Password", () => {
    expect(mapOnePasswordCategory("Login")).toBe("login");
    expect(mapOnePasswordCategory("SecureNote")).toBe("secure-note");
    expect(mapOnePasswordCategory("CreditCard")).toBe("credit-card");
    expect(mapOnePasswordCategory("CryptoWallet")).toBe("crypto-wallet");
    expect(mapOnePasswordCategory("Identity")).toBe("identity");
    expect(mapOnePasswordCategory("Password")).toBe("password");
    expect(mapOnePasswordCategory("Document")).toBe("document");
    expect(mapOnePasswordCategory("ApiCredentials")).toBe("api-credential");
    expect(mapOnePasswordCategory("BankAccount")).toBe("bank-account");
    expect(mapOnePasswordCategory("Database")).toBe("database");
    expect(mapOnePasswordCategory("DriverLicense")).toBe("driver-license");
    expect(mapOnePasswordCategory("Email")).toBe("email");
    expect(mapOnePasswordCategory("MedicalRecord")).toBe("medical-record");
    expect(mapOnePasswordCategory("Membership")).toBe("membership");
    expect(mapOnePasswordCategory("OutdoorLicense")).toBe("outdoor-license");
    expect(mapOnePasswordCategory("Passport")).toBe("passport");
    expect(mapOnePasswordCategory("Rewards")).toBe("rewards");
    expect(mapOnePasswordCategory("Router")).toBe("router");
    expect(mapOnePasswordCategory("Server")).toBe("server");
    expect(mapOnePasswordCategory("SshKey")).toBe("ssh-key");
    expect(mapOnePasswordCategory("SocialSecurityNumber")).toBe("social-security-number");
    expect(mapOnePasswordCategory("SoftwareLicense")).toBe("software-license");
    expect(mapOnePasswordCategory("Person")).toBe("person");
    expect(mapOnePasswordCategory("Unsupported")).toBe("unsupported");
  });
});

describe("OnePasswordService", () => {
  beforeEach(() => {
    sdkMock.createClient.mockReset();
    desktopAppMock.execFile.mockReset();
    desktopAppMock.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(null, "", "");
    });
  });

  it("removes requested tags from the latest item before updating", async () => {
    const latest = {
      ...loginItem("item-1"),
      vaultId: "vault-1",
      tags: ["CSV Import", "work"]
    };
    const get = vi.fn().mockResolvedValue(latest);
    const put = vi.fn(async (item: typeof latest) => item);
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [{ id: "vault-1", title: "Personal" }])
      },
      items: {
        list: vi.fn(() => [{ id: "item-1" }]),
        getAll: vi.fn(async () => ({ individualResponses: [{ content: latest }] })),
        get,
        put
      }
    });

    const service = new OnePasswordService();
    await service.scan({ serviceAccountToken: "ops-test" });
    await service.removeTags("vault-1:item-1", ["CSV Import"]);

    expect(get).toHaveBeenCalledWith("vault-1", "item-1");
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ tags: ["work"] }));
  });

  it("removes archived items from the local mutation cache", async () => {
    const item = { ...loginItem("item-1"), vaultId: "vault-1" };
    const archive = vi.fn();
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [{ id: "vault-1", title: "Personal" }])
      },
      items: {
        list: vi.fn(() => [{ id: "item-1" }]),
        getAll: vi.fn(async () => ({ individualResponses: [{ content: item }] })),
        archive,
        get: vi.fn()
      }
    });

    const service = new OnePasswordService();
    await service.scan({ serviceAccountToken: "ops-test" });
    await service.archive("vault-1", "item-1");

    await expect(service.removeTags("vault-1:item-1", [])).rejects.toThrow("扫描缓存中没有完整项目数据");
    expect(archive).toHaveBeenCalledWith("vault-1", "item-1");
  });

  it("adds a moved copy to the local mutation cache", async () => {
    const source = {
      ...loginItem("item-1"),
      vaultId: "vault-1",
      tags: ["CSV Import", "work"],
      sections: [],
      files: []
    };
    const created = { ...source, id: "created-1", vaultId: "vault-2", tags: ["work"] };
    const get = vi.fn(async (vaultId: string, itemId: string) => vaultId === "vault-2" && itemId === "created-1" ? created : source);
    const put = vi.fn(async (item: typeof created) => item);
    const archive = vi.fn();
    const create = vi.fn(async () => created);
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [{ id: "vault-1", title: "Personal" }, { id: "vault-2", title: "Archive" }])
      },
      items: {
        list: vi.fn((vaultId: string) => vaultId === "vault-1" ? [{ id: "item-1" }] : []),
        getAll: vi.fn(async (_vaultId: string, itemIds: string[]) => ({ individualResponses: itemIds.map(() => ({ content: source })) })),
        get,
        put,
        create,
        archive,
        files: { read: vi.fn() }
      }
    });

    const service = new OnePasswordService();
    await service.scan({ serviceAccountToken: "ops-test" });
    await service.copyToVaultAndArchiveSource("vault-1:item-1", "vault-2", ["CSV Import"]);
    await service.removeTags("vault-2:created-1", ["work"]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ vaultId: "vault-2", tags: ["work"] }));
    expect(archive).toHaveBeenCalledWith("vault-1", "item-1");
    expect(get).toHaveBeenLastCalledWith("vault-2", "created-1");
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "created-1", tags: [] }));
  });

  it("reads full items in SDK-sized batches", async () => {
    const itemIds = Array.from({ length: 121 }, (_, index) => `item-${index}`);
    const getAll = vi.fn(async (_vaultId: string, batch: string[]) => ({
      individualResponses: batch.map((id) => ({
        content: loginItem(id)
      }))
    }));
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [{ id: "vault-1", title: "Personal" }])
      },
      items: {
        list: vi.fn(() => itemIds.map((id) => ({ id }))),
        getAll
      }
    });

    const service = new OnePasswordService();
    await service.scan({ serviceAccountToken: "ops-test" });

    expect(getAll).toHaveBeenCalledTimes(3);
    expect(getAll.mock.calls.map((call) => call[1])).toEqual([
      itemIds.slice(0, 50),
      itemIds.slice(50, 100),
      itemIds.slice(100)
    ]);
  });

  it("reports discovered vault item counts before item details are read", async () => {
    const itemIds = ["item-1", "item-2"];
    const list = vi.fn(() => itemIds.map((id) => ({ id })));
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [{ id: "vault-1", title: "Personal" }])
      },
      items: {
        list,
        getAll: vi.fn(async (_vaultId: string, batch: string[]) => ({
          individualResponses: batch.map((id) => ({
            content: loginItem(id)
          }))
        }))
      }
    });

    const events: ScanProgressEvent[] = [];
    const service = new OnePasswordService();
    await service.scan({
      serviceAccountToken: "ops-test",
      onProgress: (event) => events.push(event)
    });

    const discovered = events.find((event) => event.progress.message === "已发现 Personal 中的 2 个项目。");

    expect(discovered?.progress.totalItems).toBe(2);
    expect(discovered?.progress.scannedItems).toBe(0);
    expect(list).toHaveBeenCalledWith("vault-1");
    expect(discovered?.progress.vaults[0]).toEqual(
      expect.objectContaining({
        id: "vault-1",
        name: "Personal",
        itemCount: 2,
        categoryCounts: expect.objectContaining({
          login: 0
        })
      })
    );
  });

  it("reads vaults serially", async () => {
    const vaults = Array.from({ length: 4 }, (_, index) => ({
      id: `vault-${index}`,
      title: `Vault ${index}`
    }));
    let inFlightGetAll = 0;
    let maxInFlightGetAll = 0;
    const getAll = vi.fn(async (vaultId: string, batch: string[]) => {
      inFlightGetAll += 1;
      maxInFlightGetAll = Math.max(maxInFlightGetAll, inFlightGetAll);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlightGetAll -= 1;
      return {
        individualResponses: batch.map((id) => ({
          content: {
            id,
            category: "Login",
            title: `${vaultId}:${id}`,
            fields: [],
            websites: [],
            tags: []
          }
        }))
      };
    });
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => vaults)
      },
      items: {
        list: vi.fn((vaultId: string) => [{ id: `${vaultId}-item` }]),
        getAll
      }
    });

    const service = new OnePasswordService();
    const scan = await service.scan({ serviceAccountToken: "ops-test" });

    expect(scan.items).toHaveLength(4);
    expect(getAll).toHaveBeenCalledTimes(4);
    expect(maxInFlightGetAll).toBe(1);
  });

  it("reads Desktop-auth vaults serially to avoid IPC contention", async () => {
    const vaults = Array.from({ length: 3 }, (_, index) => ({
      id: `desktop-vault-${index}`,
      title: `Desktop Vault ${index}`
    }));
    let inFlightGetAll = 0;
    let maxInFlightGetAll = 0;
    const getAll = vi.fn(async (vaultId: string, batch: string[]) => {
      inFlightGetAll += 1;
      maxInFlightGetAll = Math.max(maxInFlightGetAll, inFlightGetAll);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlightGetAll -= 1;
      return {
        individualResponses: batch.map((id) => ({
          content: {
            id,
            category: "Login",
            title: `${vaultId}:${id}`,
            fields: [],
            websites: [],
            tags: []
          }
        }))
      };
    });
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => vaults)
      },
      items: {
        list: vi.fn((vaultId: string) => [{ id: `${vaultId}-item` }]),
        getAll
      }
    });

    const service = new OnePasswordService();
    const scan = await service.scan({ accountName: "example-account" });

    expect(scan.items).toHaveLength(3);
    expect(getAll).toHaveBeenCalledTimes(3);
    expect(maxInFlightGetAll).toBe(1);
  });

  it("fails the scan without single-item retries when a batch retrieval fails", async () => {
    const itemIds = ["item-ok", "item-bad", "item-later"];
    const getAll = vi.fn(async () => {
      throw new Error("Unexpected error when retrieving response contents");
    });
    const get = vi.fn(async (_vaultId: string, itemId: string) => {
      if (itemId === "item-bad") {
        throw new Error("Cannot retrieve item");
      }
      return loginItem(itemId);
    });
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [{ id: "vault-1", title: "Personal" }])
      },
      items: {
        list: vi.fn(() => itemIds.map((id) => ({ id }))),
        getAll,
        get
      }
    });

    const service = new OnePasswordService();
    await expect(service.scan({ serviceAccountToken: "ops-test" })).rejects.toThrow("Unexpected error when retrieving response contents");

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("reports missing batch responses without single-item retries", async () => {
    const itemIds = ["item-1", "item-2"];
    const getAll = vi.fn(async () => ({
      individualResponses: [
        {
          content: loginItem("item-1")
        }
      ]
    }));
    const get = vi.fn(async (_vaultId: string, itemId: string) => loginItem(itemId));
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [{ id: "vault-1", title: "Personal" }])
      },
      items: {
        list: vi.fn(() => itemIds.map((id) => ({ id }))),
        getAll,
        get
      }
    });

    const service = new OnePasswordService();
    const scan = await service.scan({ serviceAccountToken: "ops-test" });

    expect(scan.items.map((item) => item.onePasswordItemId)).toEqual(["item-1"]);
    expect(get).not.toHaveBeenCalled();
  });

  it("opens the 1Password desktop app before DesktopAuth scans", async () => {
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [])
      },
      items: {
        list: vi.fn(),
        getAll: vi.fn()
      }
    });

    const events: ScanProgressEvent[] = [];
    const service = new OnePasswordService();
    await service.scan({
      accountName: "BppleMan",
      onProgress: (event) => events.push(event)
    });

    expect(desktopAppMock.execFile).toHaveBeenCalledWith(
      "open",
      ["-b", "com.1password.1password"],
      { timeout: 5000 },
      expect.any(Function)
    );
    expect(events.some((event) => event.progress.message === "正在唤起 1Password Desktop App。")).toBe(true);
    expect(events.some((event) => event.progress.message === "正在等待 1Password 授权。")).toBe(true);
  });

  it("fails before detail scanning when a vault item list cannot be read", async () => {
    const list = vi.fn(async (vaultId: string) => {
      if (vaultId === "vault-broken") {
        throw new Error("Unexpected error when retrieving response contents");
      }
      return [{ id: "item-ok" }];
    });
    const getAll = vi.fn(async (_vaultId: string, batch: string[]) => ({
      individualResponses: batch.map((id) => ({
        content: loginItem(id)
      }))
    }));
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [
          { id: "vault-broken", title: "Broken" },
          { id: "vault-ok", title: "Personal" }
        ])
      },
      items: {
        list,
        getAll
      }
    });

    const service = new OnePasswordService();
    await expect(service.scan({ serviceAccountToken: "ops-test" })).rejects.toThrow("Unexpected error when retrieving response contents");

    expect(list).toHaveBeenCalledTimes(1);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("reports a focused error when no vault item lists can be read", async () => {
    sdkMock.createClient.mockResolvedValue({
      vaults: {
        list: vi.fn(() => [
          { id: "vault-1", title: "Personal" },
          { id: "vault-2", title: "Work" }
        ])
      },
      items: {
        list: vi.fn(async () => {
          throw new Error("Unexpected error when retrieving response contents");
        })
      }
    });

    const service = new OnePasswordService();

    await expect(service.scan({ serviceAccountToken: "ops-test" })).rejects.toThrow("Unexpected error when retrieving response contents");
  });

  it("releases the cached SDK client when clearing local scan state", async () => {
    sdkMock.createClient
      .mockResolvedValueOnce(createMinimalClient("first-vault"))
      .mockResolvedValueOnce(createMinimalClient("second-vault"));

    const service = new OnePasswordService();
    await service.scan({ accountName: "example-account" });
    await service.scan({ accountName: "example-account" });

    expect(sdkMock.createClient).toHaveBeenCalledTimes(1);

    service.clearCache();
    await service.scan({ accountName: "example-account" });

    expect(sdkMock.createClient).toHaveBeenCalledTimes(2);
  });

  it("does not restart the whole scan when the desktop client id expires", async () => {
    sdkMock.createClient
      .mockResolvedValueOnce({
        vaults: {
          list: vi.fn(() => {
            throw new Error("invalid client id");
          })
        },
        items: {
          list: vi.fn(),
          getAll: vi.fn()
        }
      })
      .mockResolvedValueOnce(createMinimalClient("fresh-vault"));

    const service = new OnePasswordService();
    await expect(service.scan({ accountName: "example-account" })).rejects.toThrow("invalid client id");

    expect(sdkMock.createClient).toHaveBeenCalledTimes(1);
  });
});

function createMinimalClient(vaultId: string) {
  return {
    vaults: {
      list: vi.fn(() => [{ id: vaultId, title: vaultId }])
    },
    items: {
      list: vi.fn(() => [{ id: "item-1" }]),
      getAll: vi.fn(async () => ({
        individualResponses: [
          {
            content: {
              id: "item-1",
              category: "Login",
              title: "Login",
              fields: [],
              websites: [],
              tags: []
            }
          }
        ]
      }))
    }
  };
}
