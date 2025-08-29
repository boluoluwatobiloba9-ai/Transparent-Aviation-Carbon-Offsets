# 🌍 Transparent Aviation Carbon Offsets

Welcome to a revolutionary Web3 solution for tackling aviation's carbon footprint! This project creates a transparent, blockchain-based system on Stacks that links airline flights directly to verified reforestation projects. By using smart contracts in Clarity, it ensures immutable tracking of emissions, offsets, and verifications, solving the real-world problem of opaque carbon offset programs where funds often fail to reach genuine environmental initiatives.

## ✨ Features

🔗 Link flights to specific reforestation projects with on-chain proofs  
📊 Calculate and record carbon emissions transparently  
🌳 Verify reforestation projects through decentralized oracles and audits  
💰 Tokenize offsets as NFTs for tradable, verifiable credits  
🔍 Public dashboard for querying flight-offset linkages  
🚫 Prevent double-counting of offsets with unique identifiers  
📈 Governance for community-driven improvements and verifications  
✅ Third-party audits integrated on-chain for trust

## 🛠 How It Works

This system leverages 8 interconnected smart contracts written in Clarity to handle registration, calculation, verification, and linking. It empowers airlines, passengers, project owners, and verifiers to interact seamlessly on the Stacks blockchain.

**For Airlines/Passengers**  
- Register a flight with details like distance, fuel type, and passenger count.  
- The system automatically calculates emissions using standardized formulas.  
- Purchase offsets by linking to a verified reforestation project and minting an NFT credit.  
- Call the `link-flight-to-project` function with flight ID and project ID—funds are escrowed until verification.

**For Reforestation Project Owners**  
- Submit project details (location, tree count, expected CO2 absorption) for on-chain registration.  
- Use oracles to upload periodic progress reports (e.g., satellite imagery hashes).  
- Once verified, projects become eligible for offset linkages, releasing escrowed funds.

**For Verifiers/Auditors**  
- Review submitted data and vote on project legitimacy via governance.  
- Query flight-offset details to confirm no double-counting.  
- Use `verify-project` to approve or reject, triggering automatic payouts or refunds.

**For Everyone**  
- Query the blockchain for any flight's offset status using `get-offset-details`.  
- Trade offset NFTs on secondary markets for flexible carbon credit management.

Boom! End-to-end transparency ensures every ton of CO2 from aviation is offset by real, verifiable tree-planting—reducing greenwashing and building trust in sustainability.

## 📜 Smart Contracts Overview

The project is built with 8 Clarity smart contracts for modularity, security, and scalability:

1. **UserRegistry.clar**: Manages user registrations (airlines, passengers, project owners) with roles and permissions.  
2. **FlightRegistry.clar**: Stores flight data (e.g., origin, destination, emissions) and generates unique flight IDs.  
3. **EmissionCalculator.clar**: Computes carbon footprints based on input parameters using predefined formulas (integrates with math libraries if needed).  
4. **ProjectRegistry.clar**: Registers reforestation projects with metadata like location, absorption estimates, and progress milestones.  
5. **OffsetNFT.clar**: Mints and manages NFTs representing carbon offset credits, tied to specific flight-project pairs.  
6. **LinkingContract.clar**: Handles the core logic of matching flights to projects, escrowing funds, and releasing upon verification.  
7. **VerificationOracle.clar**: Integrates external data feeds for project audits (e.g., hashes of satellite images) and verifier voting.  
8. **Governance.clar**: Enables DAO-style voting for system updates, verifier approvals, and dispute resolution.

These contracts interact via public functions, ensuring data immutability and auditability on the Stacks blockchain. Start by deploying them in sequence and testing integrations!