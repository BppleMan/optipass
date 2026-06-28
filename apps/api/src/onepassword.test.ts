import { describe, expect, it } from "vitest";
import { mapOnePasswordCategory } from "./onepassword.js";

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
