// tests/linking.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Linkage {
  offsetAmount: number;
  nftId: number | null;
  status: string;
  escrowAmount: number;
  creator: string;
  creationBlock: number;
  verificationCount: number;
  rejectionCount: number;
  lastUpdated: number;
}

interface VerifierVote {
  vote: string;
  timestamp: number;
}

interface Dispute {
  initiator: string;
  reason: string;
  active: boolean;
  resolutionBlock: number | null;
}

interface RevenueShare {
  percentage: number;
  received: number;
}

interface Metadata {
  description: string;
  tags: string[];
  visibility: boolean;
}

interface ContractState {
  linkages: Map<string, Linkage>; // Key is JSON.stringify({flightId, projectId})
  verifiers: Map<string, VerifierVote>; // Key is JSON.stringify({linkageKey, verifier})
  disputes: Map<string, Dispute>; // Key is JSON.stringify(linkageKey)
  revenueShares: Map<string, RevenueShare>; // Key is JSON.stringify({linkageKey, participant})
  metadata: Map<string, Metadata>; // Key is JSON.stringify(linkageKey)
  contractOwner: string;
  isPaused: boolean;
  totalLinkages: number;
  escrowBalance: number;
}

// Mock external contracts
class FlightRegistryMock {
  validateFlight(flightId: string): ClarityResponse<boolean> {
    return flightId.startsWith("valid-") ? { ok: true, value: true } : { ok: false, value: 104 };
  }
}

class ProjectRegistryMock {
  validateProject(projectId: string): ClarityResponse<boolean> {
    return projectId.startsWith("valid-") ? { ok: true, value: true } : { ok: false, value: 105 };
  }
  getProjectOwner(projectId: string): ClarityResponse<string> {
    return { ok: true, value: "project-owner" };
  }
  getParticipants(projectId: string): ClarityResponse<string[]> {
    return { ok: true, value: [] };
  }
}

class OffsetNFTMock {
  mintNft(caller: string, flightId: string, projectId: string, offsetAmount: number): ClarityResponse<number> {
    return { ok: true, value: 1 };
  }
}

class VerificationOracleMock {
  isAuthorizedVerifier(caller: string): ClarityResponse<boolean> {
    return caller.startsWith("verifier-") ? { ok: true, value: true } : { ok: false, value: 100 };
  }
  getVerifiers(): string[] {
    return ["verifier-1", "verifier-2", "verifier-3", "verifier-4"];
  }
}

// Mock contract implementation
class LinkingContractMock {
  private state: ContractState = {
    linkages: new Map(),
    verifiers: new Map(),
    disputes: new Map(),
    revenueShares: new Map(),
    metadata: new Map(),
    contractOwner: "deployer",
    isPaused: false,
    totalLinkages: 0,
    escrowBalance: 0,
  };

  private flightRegistry = new FlightRegistryMock();
  private projectRegistry = new ProjectRegistryMock();
  private offsetNFT = new OffsetNFTMock();
  private verificationOracle = new VerificationOracleMock();

  private mockBlockHeight = 1000;
  private mockTxSender = "deployer";
  private mockStxBalances: Map<string, number> = new Map([
    ["deployer", 1000000],
    ["creator", 1000000], // Ensure creator has sufficient balance
    ["project-owner", 0],
    ["verifier-1", 0],
    ["verifier-2", 0],
    ["verifier-3", 0],
    ["verifier-4", 0],
    ["participant", 0],
    ["unauthorized", 0],
  ]);

  setMockContext(sender: string, blockHeight: number) {
    this.mockTxSender = sender;
    this.mockBlockHeight = blockHeight;
  }

  private getKey(keyObj: object): string {
    return JSON.stringify(keyObj);
  }

  private ERR_UNAUTHORIZED = 100;
  private ERR_ALREADY_LINKED = 101;
  private ERR_INVALID_STATUS = 102;
  private ERR_INSUFFICIENT_FUNDS = 103;
  private ERR_INVALID_FLIGHT = 104;
  private ERR_INVALID_PROJECT = 105;
  private ERR_ESCROW_NOT_FOUND = 106;
  private ERR_VERIFICATION_FAILED = 107;
  private ERR_DISPUTE_IN_PROGRESS = 108;
  private ERR_INVALID_AMOUNT = 109;
  private ERR_MAX_VERIFIERS_REACHED = 110;
  private ERR_ALREADY_VOTED = 111;
  private ERR_INVALID_PERCENTAGE = 112;
  private ERR_NOT_OWNER = 113;
  private ERR_CONTRACT_PAUSED = 114;

  private STATUS_PENDING = "pending";
  private STATUS_VERIFIED = "verified";
  private STATUS_REJECTED = "rejected";
  private STATUS_DISPUTED = "disputed";

  private MAX_VERIFIERS = 5;
  private VERIFICATION_THRESHOLD = 3;
  private DISPUTE_WINDOW = 144;

  pauseContract(): ClarityResponse<boolean> {
    if (this.mockTxSender !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.isPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(): ClarityResponse<boolean> {
    if (this.mockTxSender !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.isPaused = false;
    return { ok: true, value: true };
  }

  linkFlightToProject(
    flightId: string,
    projectId: string,
    offsetAmount: number,
    escrowPayment: number,
    description: string,
    tags: string[]
  ): ClarityResponse<number> {
    const key = this.getKey({ flightId, projectId });
    if (this.state.isPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    if (this.state.linkages.has(key)) {
      return { ok: false, value: this.ERR_ALREADY_LINKED };
    }
    if (offsetAmount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const senderBalance = this.mockStxBalances.get(this.mockTxSender) ?? 0;
    if (senderBalance < escrowPayment) {
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    const validateFlight = this.flightRegistry.validateFlight(flightId);
    if (!validateFlight.ok) {
      return { ok: false, value: this.ERR_INVALID_FLIGHT };
    }
    const validateProject = this.projectRegistry.validateProject(projectId);
    if (!validateProject.ok) {
      return { ok: false, value: this.ERR_INVALID_PROJECT };
    }
    const mintNft = this.offsetNFT.mintNft(this.mockTxSender, flightId, projectId, offsetAmount);
    if (!mintNft.ok) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.mockStxBalances.set(this.mockTxSender, senderBalance - escrowPayment);
    this.state.escrowBalance += escrowPayment;
    this.state.linkages.set(key, {
      offsetAmount,
      nftId: mintNft.value as number,
      status: this.STATUS_PENDING,
      escrowAmount: escrowPayment,
      creator: this.mockTxSender,
      creationBlock: this.mockBlockHeight,
      verificationCount: 0,
      rejectionCount: 0,
      lastUpdated: this.mockBlockHeight,
    });
    this.state.metadata.set(key, { description, tags, visibility: true });
    this.state.totalLinkages += 1;
    return { ok: true, value: mintNft.value as number };
  }

  voteOnVerification(flightId: string, projectId: string, vote: string): ClarityResponse<boolean> {
    const key = this.getKey({ flightId, projectId });
    const verifierKey = this.getKey({ linkageKey: { flightId, projectId }, verifier: this.mockTxSender });
    if (this.state.isPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const link = this.state.linkages.get(key);
    if (!link) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    if (link.status !== this.STATUS_PENDING) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    const isVerifier = this.verificationOracle.isAuthorizedVerifier(this.mockTxSender);
    if (!isVerifier.ok || !isVerifier.value) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    const verifierCount = this.verificationOracle.getVerifiers().filter(v =>
      this.state.verifiers.has(this.getKey({ linkageKey: { flightId, projectId }, verifier: v }))
    ).length;
    if (verifierCount >= this.MAX_VERIFIERS) {
      return { ok: false, value: this.ERR_MAX_VERIFIERS_REACHED };
    }
    if (this.state.verifiers.has(verifierKey)) {
      return { ok: false, value: this.ERR_ALREADY_VOTED };
    }
    if (vote !== "approve" && vote !== "reject") {
      return { ok: false, value: this.ERR_VERIFICATION_FAILED };
    }
    this.state.verifiers.set(verifierKey, { vote, timestamp: this.mockBlockHeight });
    if (vote === "approve") {
      link.verificationCount += 1;
    } else {
      link.rejectionCount += 1;
    }
    if (link.verificationCount >= this.VERIFICATION_THRESHOLD) {
      link.status = this.STATUS_VERIFIED;
      link.lastUpdated = this.mockBlockHeight;
      const projectOwner = this.projectRegistry.getProjectOwner(projectId).value as string;
      this.mockStxBalances.set(projectOwner, (this.mockStxBalances.get(projectOwner) ?? 0) + link.escrowAmount);
      this.state.escrowBalance -= link.escrowAmount;
    } else if (link.rejectionCount >= this.VERIFICATION_THRESHOLD) {
      link.status = this.STATUS_REJECTED;
      link.lastUpdated = this.mockBlockHeight;
      this.mockStxBalances.set(link.creator, (this.mockStxBalances.get(link.creator) ?? 0) + link.escrowAmount);
      this.state.escrowBalance -= link.escrowAmount;
    }
    return { ok: true, value: true };
  }

  initiateDispute(flightId: string, projectId: string, reason: string): ClarityResponse<boolean> {
    const key = this.getKey({ flightId, projectId });
    if (this.state.isPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const link = this.state.linkages.get(key);
    if (!link) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    if (link.status !== this.STATUS_VERIFIED) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (this.mockBlockHeight - link.lastUpdated >= this.DISPUTE_WINDOW) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (this.state.disputes.has(key)) {
      return { ok: false, value: this.ERR_DISPUTE_IN_PROGRESS };
    }
    this.state.disputes.set(key, {
      initiator: this.mockTxSender,
      reason,
      active: true,
      resolutionBlock: null,
    });
    link.status = this.STATUS_DISPUTED;
    return { ok: true, value: true };
  }

  resolveDispute(flightId: string, projectId: string, approveResolution: boolean): ClarityResponse<boolean> {
    const key = this.getKey({ flightId, projectId });
    if (this.state.isPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const dispute = this.state.disputes.get(key);
    if (!dispute) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    if (!dispute.active) {
      return { ok: false, value: this.ERR_INVALID_STATUS };
    }
    if (this.mockTxSender !== this.state.contractOwner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    dispute.active = false;
    dispute.resolutionBlock = this.mockBlockHeight;
    const link = this.state.linkages.get(key)!;
    if (approveResolution) {
      link.status = this.STATUS_VERIFIED;
    } else {
      link.status = this.STATUS_REJECTED;
      this.mockStxBalances.set(link.creator, (this.mockStxBalances.get(link.creator) ?? 0) + link.escrowAmount);
      this.state.escrowBalance -= link.escrowAmount;
    }
    link.lastUpdated = this.mockBlockHeight;
    return { ok: true, value: true };
  }

  setRevenueShare(flightId: string, projectId: string, participant: string, percentage: number): ClarityResponse<boolean> {
    const key = this.getKey({ flightId, projectId });
    if (this.state.isPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const link = this.state.linkages.get(key);
    if (!link) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    if (link.creator !== this.mockTxSender) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    if (percentage <= 0 || percentage > 100) {
      return { ok: false, value: this.ERR_INVALID_PERCENTAGE };
    }
    const shareKey = this.getKey({ linkageKey: { flightId, projectId }, participant });
    this.state.revenueShares.set(shareKey, { percentage, received: 0 });
    return { ok: true, value: true };
  }

  updateLinkageMetadata(
    flightId: string,
    projectId: string,
    newDescription: string,
    newTags: string[],
    newVisibility: boolean
  ): ClarityResponse<boolean> {
    const key = this.getKey({ flightId, projectId });
    if (this.state.isPaused) {
      return { ok: false, value: this.ERR_CONTRACT_PAUSED };
    }
    const link = this.state.linkages.get(key);
    if (!link) {
      return { ok: false, value: this.ERR_ESCROW_NOT_FOUND };
    }
    if (link.creator !== this.mockTxSender) {
      return { ok: false, value: this.ERR_NOT_OWNER };
    }
    this.state.metadata.set(key, { description: newDescription, tags: newTags, visibility: newVisibility });
    return { ok: true, value: true };
  }

  getLinkageDetails(flightId: string, projectId: string): ClarityResponse<Linkage | null> {
    const key = this.getKey({ flightId, projectId });
    return { ok: true, value: this.state.linkages.get(key) ?? null };
  }

  getMetadata(flightId: string, projectId: string): ClarityResponse<Metadata | null> {
    const key = this.getKey({ flightId, projectId });
    return { ok: true, value: this.state.metadata.get(key) ?? null };
  }

  getVerifierVote(flightId: string, projectId: string, verifier: string): ClarityResponse<VerifierVote | null> {
    const key = this.getKey({ linkageKey: { flightId, projectId }, verifier });
    return { ok: true, value: this.state.verifiers.get(key) ?? null };
  }

  getDisputeDetails(flightId: string, projectId: string): ClarityResponse<Dispute | null> {
    const key = this.getKey({ flightId, projectId });
    return { ok: false, value: this.state.disputes.get(key) ?? null };
  }

  getRevenueShare(flightId: string, projectId: string, participant: string): ClarityResponse<RevenueShare | null> {
    const key = this.getKey({ linkageKey: { flightId, projectId }, participant });
    return { ok: true, value: this.state.revenueShares.get(key) ?? null };
  }

  getTotalLinkages(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalLinkages };
  }

  getEscrowBalance(): ClarityResponse<number> {
    return { ok: true, value: this.state.escrowBalance };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.isPaused };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  creator: "creator",
  verifier1: "verifier-1",
  verifier2: "verifier-2",
  verifier3: "verifier-3",
  verifier4: "verifier-4",
  unauthorized: "unauthorized",
  participant: "participant",
};

describe("LinkingContract", () => {
  let contract: LinkingContractMock;

  beforeEach(() => {
    contract = new LinkingContractMock();
    contract.setMockContext(accounts.deployer, 1000);
    vi.resetAllMocks();
  });

  it("should allow pausing and unpausing by owner", () => {
    const pause = contract.pauseContract();
    expect(pause).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    const linkDuringPause = contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "Test description", ["carbon", "offset"]);
    expect(linkDuringPause).toEqual({ ok: false, value: 114 });

    const unpause = contract.unpauseContract();
    expect(unpause).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-owner from pausing", () => {
    contract.setMockContext(accounts.unauthorized, 1000);
    const pause = contract.pauseContract();
    expect(pause).toEqual({ ok: false, value: 100 });
  });

  it("should create a linkage with valid inputs", () => {
    contract.setMockContext(accounts.creator, 1000);
    const result = contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "Test description", ["carbon", "offset"]);
    expect(result).toEqual({ ok: true, value: 1 });
    expect(contract.getTotalLinkages()).toEqual({ ok: true, value: 1 });
    expect(contract.getEscrowBalance()).toEqual({ ok: true, value: 100 });

    const details = contract.getLinkageDetails("valid-flight", "valid-project");
    expect(details).toEqual({
      ok: true,
      value: expect.objectContaining({
        offsetAmount: 10,
        nftId: 1,
        status: "pending",
        escrowAmount: 100,
        creator: accounts.creator,
      }),
    });

    const metadata = contract.getMetadata("valid-flight", "valid-project");
    expect(metadata).toEqual({
      ok: true,
      value: expect.objectContaining({
        description: "Test description",
        tags: ["carbon", "offset"],
        visibility: true,
      }),
    });
  });

  it("should prevent linkage with invalid flight or project", () => {
    contract.setMockContext(accounts.creator, 1000);
    const invalidFlight = contract.linkFlightToProject("invalid-flight", "valid-project", 10, 100, "desc", []);
    expect(invalidFlight).toEqual({ ok: false, value: 104 });

    const invalidProject = contract.linkFlightToProject("valid-flight", "invalid-project", 10, 100, "desc", []);
    expect(invalidProject).toEqual({ ok: false, value: 105 });
  });

  it("should prevent duplicate linkages", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);
    const duplicate = contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);
    expect(duplicate).toEqual({ ok: false, value: 101 });
  });

  it("should handle verification voting and threshold", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    contract.setMockContext(accounts.verifier1, 1001);
    const vote1 = contract.voteOnVerification("valid-flight", "valid-project", "approve");
    expect(vote1).toEqual({ ok: true, value: true });

    contract.setMockContext(accounts.verifier2, 1002);
    const vote2 = contract.voteOnVerification("valid-flight", "valid-project", "approve");
    expect(vote2).toEqual({ ok: true, value: true });

    let details = contract.getLinkageDetails("valid-flight", "valid-project");
    expect(details.value?.status).toBe("pending");

    contract.setMockContext(accounts.verifier3, 1003);
    const vote3 = contract.voteOnVerification("valid-flight", "valid-project", "approve");
    expect(vote3).toEqual({ ok: true, value: true });

    details = contract.getLinkageDetails("valid-flight", "valid-project");
    expect(details.value?.status).toBe("verified");
    expect(contract.getEscrowBalance()).toEqual({ ok: true, value: 0 });
  });

  it("should handle rejection voting and threshold", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    contract.setMockContext(accounts.verifier1, 1001);
    const vote1 = contract.voteOnVerification("valid-flight", "valid-project", "reject");
    expect(vote1).toEqual({ ok: true, value: true });

    contract.setMockContext(accounts.verifier2, 1002);
    const vote2 = contract.voteOnVerification("valid-flight", "valid-project", "reject");
    expect(vote2).toEqual({ ok: true, value: true });

    contract.setMockContext(accounts.verifier3, 1003);
    const vote3 = contract.voteOnVerification("valid-flight", "valid-project", "reject");
    expect(vote3).toEqual({ ok: true, value: true });

    const details = contract.getLinkageDetails("valid-flight", "valid-project");
    expect(details.value?.status).toBe("rejected");
    expect(contract.getEscrowBalance()).toEqual({ ok: true, value: 0 });
  });

  it("should prevent unauthorized voting", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    contract.setMockContext(accounts.unauthorized, 1001);
    const vote = contract.voteOnVerification("valid-flight", "valid-project", "approve");
    expect(vote).toEqual({ ok: false, value: 100 });
  });

  it("should prevent double voting", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    contract.setMockContext(accounts.verifier1, 1001);
    contract.voteOnVerification("valid-flight", "valid-project", "approve");

    const doubleVote = contract.voteOnVerification("valid-flight", "valid-project", "approve");
    expect(doubleVote).toEqual({ ok: false, value: 111 });
  });

  it("should allow initiating and resolving disputes", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    // Simulate verification
    contract.setMockContext(accounts.verifier1, 1001);
    contract.voteOnVerification("valid-flight", "valid-project", "approve");
    contract.setMockContext(accounts.verifier2, 1002);
    contract.voteOnVerification("valid-flight", "valid-project", "approve");
    contract.setMockContext(accounts.verifier3, 1003);
    contract.voteOnVerification("valid-flight", "valid-project", "approve");

    contract.setMockContext(accounts.creator, 1004); // Within window
    const initiate = contract.initiateDispute("valid-flight", "valid-project", "Invalid verification");
    expect(initiate).toEqual({ ok: true, value: true });

    let details = contract.getLinkageDetails("valid-flight", "valid-project");
    expect(details.value?.status).toBe("disputed");

    contract.setMockContext(accounts.deployer, 1005);
    const resolveApprove = contract.resolveDispute("valid-flight", "valid-project", true);
    expect(resolveApprove).toEqual({ ok: true, value: true });

    details = contract.getLinkageDetails("valid-flight", "valid-project");
    expect(details.value?.status).toBe("verified");
  });

  it("should prevent dispute outside window", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    // Verify
    contract.setMockContext(accounts.verifier1, 1001);
    contract.voteOnVerification("valid-flight", "valid-project", "approve");
    contract.setMockContext(accounts.verifier2, 1002);
    contract.voteOnVerification("valid-flight", "valid-project", "approve");
    contract.setMockContext(accounts.verifier3, 1003);
    contract.voteOnVerification("valid-flight", "valid-project", "approve");

    contract.setMockContext(accounts.creator, 2000); // Outside window
    const initiate = contract.initiateDispute("valid-flight", "valid-project", "Late dispute");
    expect(initiate).toEqual({ ok: false, value: 102 });
  });

  it("should allow setting and getting revenue shares", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    const setShare = contract.setRevenueShare("valid-flight", "valid-project", accounts.participant, 20);
    expect(setShare).toEqual({ ok: true, value: true });

    const share = contract.getRevenueShare("valid-flight", "valid-project", accounts.participant);
    expect(share).toEqual({ ok: true, value: { percentage: 20, received: 0 } });
  });

  it("should prevent invalid percentage for revenue share", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    const invalidShare = contract.setRevenueShare("valid-flight", "valid-project", accounts.participant, 101);
    expect(invalidShare).toEqual({ ok: false, value: 112 });
  });

  it("should allow updating metadata by owner", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "old desc", ["old"]);

    const update = contract.updateLinkageMetadata("valid-flight", "valid-project", "new desc", ["new"], false);
    expect(update).toEqual({ ok: true, value: true });

    const metadata = contract.getMetadata("valid-flight", "valid-project");
    expect(metadata).toEqual({
      ok: true,
      value: { description: "new desc", tags: ["new"], visibility: false },
    });
  });

  it("should prevent non-owner from updating metadata", () => {
    contract.setMockContext(accounts.creator, 1000);
    contract.linkFlightToProject("valid-flight", "valid-project", 10, 100, "desc", []);

    contract.setMockContext(accounts.unauthorized, 1001);
    const update = contract.updateLinkageMetadata("valid-flight", "valid-project", "new", [], false);
    expect(update).toEqual({ ok: false, value: 113 });
  });
});