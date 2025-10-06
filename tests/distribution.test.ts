import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, uintCV } from "@stacks/transactions";

const ERR_UNAUTHORIZED = 1000;
const ERR_INVALID_BATCH = 1001;
const ERR_ALLOCATION_EXCEEDED = 1002;
const ERR_INSUFFICIENT_FUNDS = 1003;
const ERR_BATCH_ALREADY_REGISTERED = 1004;
const ERR_INVALID_QUANTITY = 1005;
const ERR_INVALID_PRICE = 1006;
const ERR_INVALID_HASH = 1007;
const ERR_INVALID_VARIETY = 1008;
const ERR_DELIVERY_ALREADY_CONFIRMED = 1009;
const ERR_DISPUTE_IN_PROGRESS = 1010;
const ERR_INVALID_DISPUTE_REASON = 1011;
const ERR_NOT_FARMER = 1012;
const ERR_NOT_SUPPLIER = 1013;
const ERR_BATCH_EXPIRED = 1014;
const ERR_INVALID_EXPIRY = 1015;
const ERR_MAX_BATCHES_EXCEEDED = 1016;
const ERR_INVALID_CERTIFICATION = 1017;
const ERR_ESCROW_LOCKED = 1018;
const ERR_INVALID_REPORT = 1019;
const ERR_AUTHORITY_NOT_SET = 1020;

interface Batch {
  supplier: string;
  hash: string;
  variety: string;
  quantity: number;
  pricePerUnit: number;
  expiry: number;
  certified: boolean;
}

interface Allocation {
  quantity: number;
  claimed: boolean;
  paid: boolean;
}

interface Escrow {
  amount: number;
  locked: boolean;
  released: boolean;
}

interface Dispute {
  reason: string;
  initiator: string;
  active: boolean;
  resolved: boolean;
}

interface Report {
  allocations: number;
  delivered: number;
  disputed: number;
  totalValue: number;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class DistributionHubMock {
  state: {
    nextBatchId: number;
    maxBatches: number;
    hubFee: number;
    authority: string;
    batches: Map<number, Batch>;
    allocations: Map<string, Allocation>;
    escrows: Map<string, Escrow>;
    disputes: Map<number, Dispute>;
    reports: Map<number, Report>;
  } = {
    nextBatchId: 0,
    maxBatches: 10000,
    hubFee: 500,
    authority: "ST1AUTH",
    batches: new Map(),
    allocations: new Map(),
    escrows: new Map(),
    disputes: new Map(),
    reports: new Map(),
  };
  blockHeight: number = 100;
  caller: string = "ST1SUPPLIER";
  suppliers: Set<string> = new Set(["ST1SUPPLIER"]);
  farmers: Set<string> = new Set(["ST1FARMER"]);
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];
  nftMints: Array<{ owner: string; hash: string; id: number }> = [];
  traceVerifies: Map<number, boolean> = new Map();
  escrowLocks: Array<{ farmer: string; amount: number; batchId: number }> = [];
  escrowReleases: Array<{ to: string; amount: number }> = [];
  disputesStarted: Array<{ batchId: number; reason: string; initiator: string }> = [];
  disputesResolved: Array<{ batchId: number; inFavor: boolean; resolver: string }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextBatchId: 0,
      maxBatches: 10000,
      hubFee: 500,
      authority: "ST1AUTH",
      batches: new Map(),
      allocations: new Map(),
      escrows: new Map(),
      disputes: new Map(),
      reports: new Map(),
    };
    this.blockHeight = 100;
    this.caller = "ST1SUPPLIER";
    this.suppliers = new Set(["ST1SUPPLIER"]);
    this.farmers = new Set(["ST1FARMER"]);
    this.stxTransfers = [];
    this.nftMints = [];
    this.traceVerifies = new Map();
    this.escrowLocks = [];
    this.escrowReleases = [];
    this.disputesStarted = [];
    this.disputesResolved = [];
  }

  setAuthority(newAuthority: string): Result<boolean> {
    if (this.caller !== this.state.authority) return { ok: false, value: ERR_UNAUTHORIZED };
    this.state.authority = newAuthority;
    return { ok: true, value: true };
  }

  setMaxBatches(newMax: number): Result<boolean> {
    if (this.caller !== this.state.authority) return { ok: false, value: ERR_UNAUTHORIZED };
    if (newMax <= 0) return { ok: false, value: ERR_INVALID_QUANTITY };
    this.state.maxBatches = newMax;
    return { ok: true, value: true };
  }

  setHubFee(newFee: number): Result<boolean> {
    if (this.caller !== this.state.authority) return { ok: false, value: ERR_UNAUTHORIZED };
    this.state.hubFee = newFee;
    return { ok: true, value: true };
  }

  registerBatch(batchHash: string, variety: string, quantity: number, pricePerUnit: number, expiry: number): Result<number> {
    const batchId = this.state.nextBatchId + 1;
    if (this.state.nextBatchId >= this.state.maxBatches) return { ok: false, value: ERR_MAX_BATCHES_EXCEEDED };
    if (batchHash.length === 0 || batchHash.length > 64) return { ok: false, value: ERR_INVALID_HASH };
    if (variety.length === 0 || variety.length > 32) return { ok: false, value: ERR_INVALID_VARIETY };
    if (quantity <= 0) return { ok: false, value: ERR_INVALID_QUANTITY };
    if (pricePerUnit <= 0) return { ok: false, value: ERR_INVALID_PRICE };
    if (expiry <= this.blockHeight) return { ok: false, value: ERR_INVALID_EXPIRY };
    if (!this.suppliers.has(this.caller)) return { ok: false, value: ERR_NOT_SUPPLIER };
    if (this.state.batches.has(batchId)) return { ok: false, value: ERR_BATCH_ALREADY_REGISTERED };
    this.nftMints.push({ owner: this.caller, hash: batchHash, id: batchId });
    this.traceVerifies.set(batchId, true);
    this.state.batches.set(batchId, { supplier: this.caller, hash: batchHash, variety, quantity, pricePerUnit, expiry, certified: true });
    this.state.reports.set(batchId, { allocations: 0, delivered: 0, disputed: 0, totalValue: 0 });
    this.state.nextBatchId = batchId;
    return { ok: true, value: batchId };
  }

  allocateSeeds(batchId: number, allocQuantity: number): Result<boolean> {
    const batch = this.state.batches.get(batchId);
    if (!batch) return { ok: false, value: ERR_INVALID_BATCH };
    const totalCost = allocQuantity * batch.pricePerUnit;
    const availQuantity = batch.quantity;
    if (!this.farmers.has(this.caller)) return { ok: false, value: ERR_NOT_FARMER };
    if (allocQuantity > availQuantity) return { ok: false, value: ERR_ALLOCATION_EXCEEDED };
    if (allocQuantity <= 0) return { ok: false, value: ERR_INVALID_QUANTITY };
    if (this.blockHeight >= batch.expiry) return { ok: false, value: ERR_BATCH_EXPIRED };
    const allocKey = `${batchId}-${this.caller}`;
    if (this.state.allocations.has(allocKey)) return { ok: false, value: ERR_INVALID_BATCH };
    if (this.state.disputes.has(batchId)) return { ok: false, value: ERR_DISPUTE_IN_PROGRESS };
    this.stxTransfers.push({ amount: this.state.hubFee, from: this.caller, to: this.state.authority });
    this.escrowLocks.push({ farmer: this.caller, amount: totalCost, batchId });
    this.state.allocations.set(allocKey, { quantity: allocQuantity, claimed: false, paid: false });
    this.state.escrows.set(allocKey, { amount: totalCost, locked: true, released: false });
    this.state.batches.set(batchId, { ...batch, quantity: availQuantity - allocQuantity });
    const report = this.state.reports.get(batchId)!;
    this.state.reports.set(batchId, { ...report, allocations: report.allocations + 1, totalValue: report.totalValue + totalCost });
    return { ok: true, value: true };
  }

  confirmDelivery(batchId: number, traceHash: string): Result<boolean> {
    const allocKey = `${batchId}-${this.caller}`;
    const alloc = this.state.allocations.get(allocKey);
    if (!alloc) return { ok: false, value: ERR_INVALID_BATCH };
    const esc = this.state.escrows.get(allocKey);
    if (!esc) return { ok: false, value: ERR_INVALID_BATCH };
    const batch = this.state.batches.get(batchId);
    if (!batch) return { ok: false, value: ERR_INVALID_BATCH };
    if (alloc.claimed) return { ok: false, value: ERR_DELIVERY_ALREADY_CONFIRMED };
    if (!esc.locked) return { ok: false, value: ERR_ESCROW_LOCKED };
    if (esc.released) return { ok: false, value: ERR_DELIVERY_ALREADY_CONFIRMED };
    if (!this.traceVerifies.get(batchId)) return { ok: false, value: ERR_INVALID_HASH };
    if (this.state.disputes.has(batchId)) return { ok: false, value: ERR_DISPUTE_IN_PROGRESS };
    this.escrowReleases.push({ to: batch.supplier, amount: esc.amount });
    this.state.allocations.set(allocKey, { ...alloc, claimed: true, paid: true });
    this.state.escrows.set(allocKey, { ...esc, locked: false, released: true });
    const report = this.state.reports.get(batchId)!;
    this.state.reports.set(batchId, { ...report, delivered: report.delivered + 1 });
    return { ok: true, value: true };
  }

  initiateDispute(batchId: number, reason: string): Result<boolean> {
    const batch = this.state.batches.get(batchId);
    if (!batch) return { ok: false, value: ERR_INVALID_BATCH };
    if (reason.length === 0 || reason.length > 256) return { ok: false, value: ERR_INVALID_DISPUTE_REASON };
    const isSupplier = this.caller === batch.supplier;
    const allocKey = `${batchId}-${this.caller}`;
    const isFarmer = this.state.allocations.has(allocKey);
    if (!isSupplier && !isFarmer) return { ok: false, value: ERR_UNAUTHORIZED };
    if (this.state.disputes.has(batchId)) return { ok: false, value: ERR_DISPUTE_IN_PROGRESS };
    this.disputesStarted.push({ batchId, reason, initiator: this.caller });
    this.state.disputes.set(batchId, { reason, initiator: this.caller, active: true, resolved: false });
    const report = this.state.reports.get(batchId)!;
    this.state.reports.set(batchId, { ...report, disputed: report.disputed + 1 });
    return { ok: true, value: true };
  }

  resolveDispute(batchId: number, inFavorOfSupplier: boolean): Result<boolean> {
    const dispute = this.state.disputes.get(batchId);
    if (!dispute) return { ok: false, value: ERR_INVALID_BATCH };
    if (!dispute.active) return { ok: false, value: ERR_INVALID_BATCH };
    if (this.caller !== this.state.authority) return { ok: false, value: ERR_UNAUTHORIZED };
    this.disputesResolved.push({ batchId, inFavor: inFavorOfSupplier, resolver: this.caller });
    this.state.disputes.set(batchId, { ...dispute, active: false, resolved: true });
    return { ok: true, value: true };
  }

  getBatchCount(): Result<number> {
    return { ok: true, value: this.state.nextBatchId };
  }
}

describe("DistributionHub", () => {
  let contract: DistributionHubMock;

  beforeEach(() => {
    contract = new DistributionHubMock();
    contract.reset();
  });

  it("registers a batch successfully", () => {
    const result = contract.registerBatch("hash123", "corn", 1000, 10, 200);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1);
    const batch = contract.state.batches.get(1);
    expect(batch?.hash).toBe("hash123");
    expect(batch?.variety).toBe("corn");
    expect(batch?.quantity).toBe(1000);
    expect(batch?.pricePerUnit).toBe(10);
    expect(batch?.expiry).toBe(200);
    expect(contract.nftMints).toEqual([{ owner: "ST1SUPPLIER", hash: "hash123", id: 1 }]);
  });

  it("rejects invalid hash in register", () => {
    const result = contract.registerBatch("", "corn", 1000, 10, 200);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_HASH);
  });

  it("rejects non-supplier in register", () => {
    contract.caller = "ST2INVALID";
    contract.suppliers = new Set();
    const result = contract.registerBatch("hash123", "corn", 1000, 10, 200);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_SUPPLIER);
  });

  it("allocates seeds successfully", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST1FARMER";
    const result = contract.allocateSeeds(1, 500);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const allocKey = "1-ST1FARMER";
    const alloc = contract.state.allocations.get(allocKey);
    expect(alloc?.quantity).toBe(500);
    expect(alloc?.claimed).toBe(false);
    const esc = contract.state.escrows.get(allocKey);
    expect(esc?.amount).toBe(5000);
    expect(esc?.locked).toBe(true);
    const batch = contract.state.batches.get(1);
    expect(batch?.quantity).toBe(500);
    const report = contract.state.reports.get(1);
    expect(report?.allocations).toBe(1);
    expect(report?.totalValue).toBe(5000);
    expect(contract.stxTransfers).toEqual([{ amount: 500, from: "ST1FARMER", to: "ST1AUTH" }]);
    expect(contract.escrowLocks).toEqual([{ farmer: "ST1FARMER", amount: 5000, batchId: 1 }]);
  });

  it("rejects allocation exceeded", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST1FARMER";
    const result = contract.allocateSeeds(1, 1500);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ALLOCATION_EXCEEDED);
  });

  it("confirms delivery successfully", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST1FARMER";
    contract.allocateSeeds(1, 500);
    const result = contract.confirmDelivery(1, "hash123");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const allocKey = "1-ST1FARMER";
    const alloc = contract.state.allocations.get(allocKey);
    expect(alloc?.claimed).toBe(true);
    expect(alloc?.paid).toBe(true);
    const esc = contract.state.escrows.get(allocKey);
    expect(esc?.locked).toBe(false);
    expect(esc?.released).toBe(true);
    const report = contract.state.reports.get(1);
    expect(report?.delivered).toBe(1);
    expect(contract.escrowReleases).toEqual([{ to: "ST1SUPPLIER", amount: 5000 }]);
  });

  it("rejects already confirmed delivery", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST1FARMER";
    contract.allocateSeeds(1, 500);
    contract.confirmDelivery(1, "hash123");
    const result = contract.confirmDelivery(1, "hash123");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_DELIVERY_ALREADY_CONFIRMED);
  });

  it("initiates dispute successfully", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST1FARMER";
    contract.allocateSeeds(1, 500);
    const result = contract.initiateDispute(1, "bad quality");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const dispute = contract.state.disputes.get(1);
    expect(dispute?.reason).toBe("bad quality");
    expect(dispute?.initiator).toBe("ST1FARMER");
    expect(dispute?.active).toBe(true);
    const report = contract.state.reports.get(1);
    expect(report?.disputed).toBe(1);
    expect(contract.disputesStarted).toEqual([{ batchId: 1, reason: "bad quality", initiator: "ST1FARMER" }]);
  });

  it("rejects invalid initiator for dispute", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST2INVALID";
    const result = contract.initiateDispute(1, "bad quality");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("resolves dispute successfully", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST1FARMER";
    contract.allocateSeeds(1, 500);
    contract.initiateDispute(1, "bad quality");
    contract.caller = "ST1AUTH";
    const result = contract.resolveDispute(1, true);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const dispute = contract.state.disputes.get(1);
    expect(dispute?.active).toBe(false);
    expect(dispute?.resolved).toBe(true);
    expect(contract.disputesResolved).toEqual([{ batchId: 1, inFavor: true, resolver: "ST1AUTH" }]);
  });

  it("rejects non-authority for resolve", () => {
    contract.registerBatch("hash123", "corn", 1000, 10, 200);
    contract.caller = "ST1FARMER";
    contract.allocateSeeds(1, 500);
    contract.initiateDispute(1, "bad quality");
    contract.caller = "ST2INVALID";
    const result = contract.resolveDispute(1, true);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("sets hub fee successfully", () => {
    contract.caller = "ST1AUTH";
    const result = contract.setHubFee(1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.hubFee).toBe(1000);
  });

  it("rejects non-authority for set fee", () => {
    contract.caller = "ST2INVALID";
    const result = contract.setHubFee(1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_UNAUTHORIZED);
  });

  it("gets batch count correctly", () => {
    contract.registerBatch("hash1", "corn", 1000, 10, 200);
    contract.registerBatch("hash2", "wheat", 2000, 15, 300);
    const result = contract.getBatchCount();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
  });
});