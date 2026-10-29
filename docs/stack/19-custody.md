# 19 — Reference auxiliary custody

The reference process owns one auxiliary checkpoint writer separately from its
Host's original-operation journal. It stores only exact read-helper custody;
it does not admit agent commands, create sessions, retry native effects or own
another catalog. AuxiliaryCustody consumes just the writer's checkpoint read
and write capabilities. Its serialized state is private operator state.

Each actual adapter admits an inert reader into its existing reader set before
any asynchronous work. One helper per logical session scope is intentional:
model and history callers share a retained binding or close their helper before
asking for another. A contender receives BUSY before native allocation. It cannot
present the persisted capsule as recovery input to retire another live Reader
behind that Reader object's back. Actual exact close alone releases admission.
There is no second auxiliary registry or ownership map. Persisted prior capsules
remain useful after process loss when the new adapter has no live reader owner.
Direct low-level Reader construction requires the consuming composition to hold
an exclusive lease through actual close; separate adapters must not share one
logical auxiliary custody record.

The complete checkpoint record is validated before use: supported version,
strict variant fields, bounded scope/native identity, generation and exact
opening/capsule structure. Nested run identity must agree with the outer record;
allocated openings must agree with that run's scope and generation. Unknown
phases, malformed empty records and foreign scopes fail closed without writes.
Allocated, owned and unconfirmed custody cannot move to another run. A fully
validated none record may move generation because it retains no resource; that
absence does not establish that any native conversation is stopped. Releasing
owned custody requires the runtime's exact positive sealed-tree Stop proof.

Focused strict compilation passed. Two adapter scripted race oracles passed in
245ms: concurrent same-scope readers allocate once, the first remains readable,
and replacement is allowed only after exact close, with zero Create/Resume.
Two pure checkpoint-port oracles passed in focused runs: malformed records
perform no writes; foreign Stop proof cannot release ownership and only exact
release allows a later-generation lease. The latter originally asserted the
runtime's message text; it now asserts the actual FENCED error code. These tests
use scripted native ports and in-memory checkpoint fixtures, not SQLite restart,
vendor processes, model calls, deployed services or platform containment proof.
The earlier finite real-SQLite catalog gate is separate evidence.
