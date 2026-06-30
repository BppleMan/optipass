import { describe, expect, it, vi } from "vitest";

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

vi.mock("@1password/sdk", () => ({
  default: {
    createClient: sdkMock.createClient,
    DesktopAuth: sdkMock.DesktopAuth
  }
}));

import { mapOnePasswordCategory, OnePasswordService } from "./onepassword.js";

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
  it("reads full items in SDK-sized batches", async () => {
    const itemIds = Array.from({ length: 121 }, (_, index) => `item-${index}`);
    const getAll = vi.fn(async (_vaultId: string, batch: string[]) => ({
      individualResponses: batch.map((id) => ({
        content: {
          id,
          category: "Login",
          title: id,
          fields: [],
          websites: [],
          tags: []
        }
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
});
