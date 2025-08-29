;; LinkingContract.clar
;; Core contract for linking flights to reforestation projects in the Transparent Aviation Carbon Offsets system.
;; Handles linkage creation, escrow management, verification, NFT minting, and advanced features like multi-verifier consensus,
;; dispute resolution, revenue sharing for projects, and status updates.

;; Constants
(define-constant ERR-UNAUTHORIZED (err u100))
(define-constant ERR-ALREADY-LINKED (err u101))
(define-constant ERR-INVALID-STATUS (err u102))
(define-constant ERR-INSUFFICIENT-FUNDS (err u103))
(define-constant ERR-INVALID-FLIGHT (err u104))
(define-constant ERR-INVALID-PROJECT (err u105))
(define-constant ERR-ESCROW-NOT-FOUND (err u106))
(define-constant ERR-VERIFICATION-FAILED (err u107))
(define-constant ERR-DISPUTE-IN-PROGRESS (err u108))
(define-constant ERR-INVALID-AMOUNT (err u109))
(define-constant ERR-MAX-VERIFIERS-REACHED (err u110))
(define-constant ERR-ALREADY-VOTED (err u111))
(define-constant ERR-INVALID-PERCENTAGE (err u112))
(define-constant ERR-NOT-OWNER (err u113))
(define-constant ERR-CONTRACT-PAUSED (err u114))

(define-constant STATUS-PENDING "pending")
(define-constant STATUS-VERIFIED "verified")
(define-constant STATUS-REJECTED "rejected")
(define-constant STATUS-DISPUTED "disputed")

(define-constant MAX-VERIFIERS u5) ;; Maximum verifiers per linkage
(define-constant VERIFICATION-THRESHOLD u3) ;; Minimum votes needed for verification
(define-constant DISPUTE_WINDOW u144) ;; Blocks for dispute initiation (approx 1 day)

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var is-paused bool false)
(define-data-var total-linkages uint u0)
(define-data-var escrow-balance uint u0)

;; Data Maps
(define-map linkages
  { flight-id: (string-ascii 64), project-id: (string-ascii 64) }
  {
    offset-amount: uint, ;; CO2 offset in tons
    nft-id: (optional uint),
    status: (string-ascii 20),
    escrow-amount: uint,
    creator: principal,
    creation-block: uint,
    verification-count: uint,
    rejection-count: uint,
    last-updated: uint
  }
)

(define-map verifiers
  { linkage-key: { flight-id: (string-ascii 64), project-id: (string-ascii 64) }, verifier: principal }
  { vote: (string-ascii 10), ;; "approve" or "reject"
    timestamp: uint }
)

(define-map disputes
  { linkage-key: { flight-id: (string-ascii 64), project-id: (string-ascii 64) } }
  {
    initiator: principal,
    reason: (string-utf8 200),
    active: bool,
    resolution-block: (optional uint)
  }
)

(define-map revenue-shares
  { linkage-key: { flight-id: (string-ascii 64), project-id: (string-ascii 64) }, participant: principal }
  { percentage: uint, ;; 0-100
    received: uint }
)

(define-map linkage-metadata
  { linkage-key: { flight-id: (string-ascii 64), project-id: (string-ascii 64) } }
  { description: (string-utf8 500),
    tags: (list 10 (string-ascii 32)),
    visibility: bool }
)

;; Private Functions
(define-private (is-contract-owner (caller principal))
  (is-eq caller (var-get contract-owner))
)

(define-private (update-status (key { flight-id: (string-ascii 64), project-id: (string-ascii 64) }) (new-status (string-ascii 20)))
  (map-set linkages key
    (merge (unwrap-panic (map-get? linkages key))
      { status: new-status, last-updated: block-height }))
)

(define-private (increment-verification (key { flight-id: (string-ascii 64), project-id: (string-ascii 64) }))
  (let ((current (unwrap-panic (map-get? linkages key))))
    (map-set linkages key
      (merge current { verification-count: (+ (get verification-count current) u1) })))
)

(define-private (increment-rejection (key { flight-id: (string-ascii 64), project-id: (string-ascii 64) }))
  (let ((current (unwrap-panic (map-get? linkages key))))
    (map-set linkages key
      (merge current { rejection-count: (+ (get rejection-count current) u1) })))
)

(define-private (check-verification-threshold (key { flight-id: (string-ascii 64), project-id: (string-ascii 64) }))
  (let ((link (unwrap-panic (map-get? linkages key))))
    (if (>= (get verification-count link) VERIFICATION-THRESHOLD)
      (begin
        (update-status key STATUS-VERIFIED)
        (try! (release-escrow key))
        true)
      (if (>= (get rejection-count link) VERIFICATION-THRESHOLD)
        (begin
          (update-status key STATUS-REJECTED)
          (try! (refund-escrow key))
          true)
        false)))
)

;; Public Functions
(define-public (pause-contract)
  (begin
    (asserts! (is-contract-owner tx-sender) ERR-UNAUTHORIZED)
    (var-set is-paused true)
    (ok true))
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-contract-owner tx-sender) ERR-UNAUTHORIZED)
    (var-set is-paused false)
    (ok true))
)

(define-public (link-flight-to-project (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (offset-amount uint) (escrow-payment uint) (description (string-utf8 500)) (tags (list 10 (string-ascii 32))))
  (let ((key { flight-id: flight-id, project-id: project-id })
        (link-exists (map-get? linkages key)))
    (asserts! (not (var-get is-paused)) ERR-CONTRACT-PAUSED)
    (asserts! (is-none link-exists) ERR-ALREADY-LINKED)
    (asserts! (> offset-amount u0) ERR-INVALID-AMOUNT)
    (asserts! (>= (stx-get-balance tx-sender) escrow-payment) ERR-INSUFFICIENT-FUNDS)
    (try! (contract-call? .FlightRegistry validate-flight flight-id))
    (try! (contract-call? .ProjectRegistry validate-project project-id))
    (let ((nft-id (unwrap! (contract-call? .OffsetNFT mint-nft tx-sender flight-id project-id offset-amount) ERR-UNAUTHORIZED)))
      (try! (stx-transfer? escrow-payment tx-sender (as-contract tx-sender)))
      (var-set escrow-balance (+ (var-get escrow-balance) escrow-payment))
      (map-set linkages key
        { offset-amount: offset-amount,
          nft-id: (some nft-id),
          status: STATUS-PENDING,
          escrow-amount: escrow-payment,
          creator: tx-sender,
          creation-block: block-height,
          verification-count: u0,
          rejection-count: u0,
          last-updated: block-height })
      (map-set linkage-metadata key
        { description: description,
          tags: tags,
          visibility: true })
      (var-set total-linkages (+ (var-get total-linkages) u1))
      (ok nft-id))
  )
)

(define-public (vote-on-verification (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (vote (string-ascii 10)))
  (let ((key { flight-id: flight-id, project-id: project-id })
        (link (map-get? linkages key))
        (verifier-entry (map-get? verifiers { linkage-key: key, verifier: tx-sender }))
        (verifier-count (len (filter (lambda (v) (is-some (map-get? verifiers { linkage-key: key, verifier: v }))) (contract-call? .VerificationOracle get-verifiers)))))
    (asserts! (not (var-get is-paused)) ERR-CONTRACT-PAUSED)
    (asserts! (is-some link) ERR-ESCROW-NOT-FOUND)
    (asserts! (is-eq (get status (unwrap-panic link)) STATUS-PENDING) ERR-INVALID-STATUS)
    (asserts! (try! (contract-call? .VerificationOracle is-authorized-verifier tx-sender)) ERR-UNAUTHORIZED)
    (asserts! (< verifier-count MAX-VERIFIERS) ERR-MAX-VERIFIERS-REACHED)
    (asserts! (is-none verifier-entry) ERR-ALREADY-VOTED)
    (asserts! (or (is-eq vote "approve") (is-eq vote "reject")) ERR-VERIFICATION-FAILED)
    (map-set verifiers { linkage-key: key, verifier: tx-sender }
      { vote: vote, timestamp: block-height })
    (if (is-eq vote "approve")
      (increment-verification key)
      (increment-rejection key))
    (check-verification-threshold key)
    (ok true)))

(define-public (initiate-dispute (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (reason (string-utf8 200)))
  (let ((key { flight-id: flight-id, project-id: project-id })
        (link (map-get? linkages key))
        (existing-dispute (map-get? disputes { linkage-key: key })))
    (asserts! (not (var-get is-paused)) ERR-CONTRACT-PAUSED)
    (asserts! (is-some link) ERR-ESCROW-NOT-FOUND)
    (asserts! (is-eq (get status (unwrap-panic link)) STATUS-VERIFIED) ERR-INVALID-STATUS)
    (asserts! (< (- block-height (get last-updated (unwrap-panic link))) DISPUTE_WINDOW) ERR-INVALID-STATUS)
    (asserts! (is-none existing-dispute) ERR-DISPUTE-IN-PROGRESS)
    (map-set disputes { linkage-key: key }
      { initiator: tx-sender,
        reason: reason,
        active: true,
        resolution-block: none })
    (update-status key STATUS-DISPUTED)
    (ok true)))

(define-public (resolve-dispute (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (approve-resolution bool))
  (let ((key { flight-id: flight-id, project-id: project-id })
        (dispute (map-get? disputes { linkage-key: key }))
        (link (map-get? linkages key)))
    (asserts! (not (var-get is-paused)) ERR-CONTRACT-PAUSED)
    (asserts! (is-some dispute) ERR-ESCROW-NOT-FOUND)
    (asserts! (get active (unwrap-panic dispute)) ERR-INVALID-STATUS)
    (asserts! (is-contract-owner tx-sender) ERR-UNAUTHORIZED)
    (map-set disputes { linkage-key: key }
      (merge (unwrap-panic dispute) { active: false, resolution-block: (some block-height) }))
    (if approve-resolution
      (update-status key STATUS-VERIFIED)
      (begin
        (update-status key STATUS-REJECTED)
        (try! (refund-escrow key))))
    (ok true)))

(define-public (set-revenue-share (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (participant principal) (percentage uint))
  (let ((key { flight-id: flight-id, project-id: project-id })
        (link (map-get? linkages key)))
    (asserts! (not (var-get is-paused)) ERR-CONTRACT-PAUSED)
    (asserts! (is-some link) ERR-ESCROW-NOT-FOUND)
    (asserts! (is-eq (get creator (unwrap-panic link)) tx-sender) ERR-NOT-OWNER)
    (asserts! (and (> percentage u0) (<= percentage u100)) ERR-INVALID-PERCENTAGE)
    (map-set revenue-shares { linkage-key: key, participant: participant }
      { percentage: percentage, received: u0 })
    (ok true)))

(define-public (update-linkage-metadata (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (new-description (string-utf8 500)) (new-tags (list 10 (string-ascii 32))) (new-visibility bool))
  (let ((key { flight-id: flight-id, project-id: project-id })
        (link (map-get? linkages key)))
    (asserts! (not (var-get is-paused)) ERR-CONTRACT-PAUSED)
    (asserts! (is-some link) ERR-ESCROW-NOT-FOUND)
    (asserts! (is-eq (get creator (unwrap-panic link)) tx-sender) ERR-NOT-OWNER)
    (map-set linkage-metadata key
      { description: new-description,
        tags: new-tags,
        visibility: new-visibility })
    (ok true)))

;; Read-Only Functions
(define-read-only (get-linkage-details (flight-id (string-ascii 64)) (project-id (string-ascii 64)))
  (map-get? linkages { flight-id: flight-id, project-id: project-id })
)

(define-read-only (get-metadata (flight-id (string-ascii 64)) (project-id (string-ascii 64)))
  (map-get? linkage-metadata { linkage-key: { flight-id: flight-id, project-id: project-id } })
)

(define-read-only (get-verifier-vote (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (verifier principal))
  (map-get? verifiers { linkage-key: { flight-id: flight-id, project-id: project-id }, verifier: verifier })
)

(define-read-only (get-dispute-details (flight-id (string-ascii 64)) (project-id (string-ascii 64)))
  (map-get? disputes { linkage-key: { flight-id: flight-id, project-id: project-id } })
)

(define-read-only (get-revenue-share (flight-id (string-ascii 64)) (project-id (string-ascii 64)) (participant principal))
  (map-get? revenue-shares { linkage-key: { flight-id: flight-id, project-id: project-id }, participant: participant })
)

(define-read-only (get-total-linkages)
  (var-get total-linkages)
)

(define-read-only (get-escrow-balance)
  (var-get escrow-balance)
)

(define-read-only (is-contract-paused)
  (var-get is-paused)
)

;; Internal Functions for Escrow Management
(define-private (release-escrow (key { flight-id: (string-ascii 64), project-id: (string-ascii 64) }))
  (let ((link (unwrap-panic (map-get? linkages key)))
        (escrow-amt (get escrow-amount link))
        (project-owner (unwrap! (contract-call? .ProjectRegistry get-project-owner (get project-id key)) ERR-INVALID-PROJECT)))
    (asserts! (is-eq (get status link) STATUS-VERIFIED) ERR-INVALID-STATUS)
    (try! (as-contract (stx-transfer? escrow-amt tx-sender project-owner)))
    (var-set escrow-balance (- (var-get escrow-balance) escrow-amt))
    ;; Distribute revenue shares if any
    (map distribute-shares (unwrap! (contract-call? .ProjectRegistry get-participants (get project-id key)) (ok (list)))
      { amount: escrow-amt, key: key })
    (ok true))
)

(define-private (refund-escrow (key { flight-id: (string-ascii 64), project-id: (string-ascii 64) }))
  (let ((link (unwrap-panic (map-get? linkages key)))
        (escrow-amt (get escrow-amount link)))
    (asserts! (or (is-eq (get status link) STATUS-REJECTED) (is-eq (get status link) STATUS-DISPUTED)) ERR-INVALID-STATUS)
    (try! (as-contract (stx-transfer? escrow-amt tx-sender (get creator link))))
    (var-set escrow-balance (- (var-get escrow-balance) escrow-amt))
    (ok true))
)

(define-private (distribute-shares (participant principal) (context { amount: uint, key: { flight-id: (string-ascii 64), project-id: (string-ascii 64) } }))
  (let ((share (unwrap-panic (get-revenue-share (get flight-id (get key context)) (get project-id (get key context)) participant)))
        (share-amt (/ (* (get amount context) (get percentage share)) u100)))
    (try! (as-contract (stx-transfer? share-amt tx-sender participant)))
    (map-set revenue-shares { linkage-key: (get key context), participant: participant }
      (merge share { received: (+ (get received share) share-amt) }))
    context)
)