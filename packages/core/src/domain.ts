export enum ItemProvider {
    OnePassword = "one-password",
    Csv = "csv",
    ChromePassword = "chrome-password",
    MacOsKeychain = "macos-keychain",
    Mock = "mock",
}

export enum ScanMode {
    Live = "live",
    Mock = "mock",
    Csv = "csv",
}

export enum ItemLifecycleState {
    Active = "active",
    Archived = "archived",
    Deleted = "deleted",
}

export enum ItemCategory {
    ApiCredential = "api-credential",
    BankAccount = "bank-account",
    CreditCard = "credit-card",
    CryptoWallet = "crypto-wallet",
    Database = "database",
    Document = "document",
    DriverLicense = "driver-license",
    Email = "email",
    Identity = "identity",
    Login = "login",
    MedicalRecord = "medical-record",
    Membership = "membership",
    OutdoorLicense = "outdoor-license",
    Passport = "passport",
    Person = "person",
    Password = "password",
    Rewards = "rewards",
    Router = "router",
    SecureNote = "secure-note",
    Server = "server",
    SshKey = "ssh-key",
    SocialSecurityNumber = "social-security-number",
    SoftwareLicense = "software-license",
    Unsupported = "unsupported",
    Unknown = "unknown",
}

export enum ItemIdentityKind {
    Username = "username",
    Email = "email",
}

export enum ItemFieldKind {
    Username = "username",
    Email = "email",
    Phone = "phone",
    Password = "password",
    Totp = "totp",
    Passkey = "passkey",
    Url = "url",
    Text = "text",
    Secret = "secret",
    Card = "card",
    Unknown = "unknown",
}

export enum ItemFieldSensitivity {
    Public = "public",
    Private = "private",
    Secret = "secret",
}

export enum ItemCapability {
    Update = "update",
    Archive = "archive",
    Delete = "delete",
    ChangeContainer = "change-container",
    Copy = "copy",
    RevealSecret = "reveal-secret",
}

export enum ItemDisposition {
    Keep = "keep",
    Archive = "archive",
    Delete = "delete",
}

export enum ActionKind {
    Keep = "keep",
    Create = "create",
    Update = "update",
    Archive = "archive",
    Delete = "delete",
}

export enum ExecutionMode {
    DryRun = "dry-run",
    Real = "real",
}

export enum DryRunSpeedMultiplier {
    One = 1,
    Five = 5,
    Ten = 10,
}

export enum ActionStepStatus {
    Pending = "pending",
    Running = "running",
    Completed = "completed",
    Failed = "failed",
    Cancelled = "cancelled",
}

export enum ActionExecutionEventKind {
    Started = "started",
    Paused = "paused",
    Resumed = "resumed",
    StopRequested = "stop-requested",
    StepStarted = "step-started",
    StepCompleted = "step-completed",
    StepFailed = "step-failed",
    AnalysisUpdated = "analysis-updated",
    Completed = "completed",
    Failed = "failed",
    Stopped = "stopped",
}

export enum ActionExecutionStatus {
    Ready = "ready",
    Starting = "starting",
    Running = "running",
    PauseRequested = "pause-requested",
    Paused = "paused",
    StopRequested = "stop-requested",
    Stopped = "stopped",
    Completed = "completed",
    Failed = "failed",
}

export enum ExecutionControlDecision {
    Continue = "continue",
    Stop = "stop",
}

export enum StoreState {
    Empty = "empty",
    Ready = "ready",
    Stale = "stale",
}

export enum VerificationSeverity {
    Critical = "critical",
    Incomplete = "incomplete",
}

export interface ItemSourceReference {
    provider: ItemProvider;
    accountId: string;
    externalItemId: string;
}

export interface ItemContainerReference {
    provider: ItemProvider;
    accountId: string;
    containerId: string;
    name: string;
}

export interface ItemIdentity {
    kind: ItemIdentityKind;
    value: string;
}

export interface ItemUrl {
    value: string;
}

export interface ItemSection {
    id: string;
    label: string;
}

export interface ItemField {
    id: string;
    sectionId?: string;
    label: string;
    kind: ItemFieldKind;
    sensitivity: ItemFieldSensitivity;
    value?: string;
    normalizedValue?: string;
    normalizedValueHash?: string;
}

export interface ItemAttachment {
    id: string;
    name: string;
    mediaType?: string;
    size?: number;
    sourceReference: ItemSourceReference;
}

export interface CanonicalItem {
    id: string;
    source: ItemSourceReference;
    container: ItemContainerReference;
    revision: number;
    lifecycleState: ItemLifecycleState;
    category: ItemCategory;
    title: string;
    notes?: string;
    createdAt?: string;
    updatedAt?: string;
    identities: ItemIdentity[];
    urls: ItemUrl[];
    tags: string[];
    sections: ItemSection[];
    fields: ItemField[];
    attachments: ItemAttachment[];
    capabilities: ItemCapability[];
}

export interface ItemStoreSnapshot {
    snapshotId: string;
    version: number;
    state: StoreState;
    createdAt: string;
    sourceProvider: ItemProvider;
    items: CanonicalItem[];
    containers: ItemContainerReference[];
}

export interface ItemPatch {
    title?: string;
    container?: ItemContainerReference;
    lifecycleState?: ItemLifecycleState;
    tags?: string[];
    updatedAt?: string;
}

export interface ItemLookupResult {
    found: boolean;
    item?: CanonicalItem;
}

export interface ItemMutationReceipt {
    sourceItemId?: string;
    createdItem?: CanonicalItem;
    updatedItem?: CanonicalItem;
    removedItemId?: string;
    resultingVersion: number;
}
