// Ported from keycard-tech/shell-units web/errors.js at tag 20261112 (MIT). Row layout and the protocol
// are specified in that repo's docs/format.md; src/js/shvr/NOTICE names what came from where.

// Two failure kinds, and conflating them is the most damaging bug this code could have.
//
// Refusal: the file, the message or the parameters are wrong — tampering, a protocol deviation, a
// format this reader does not implement. NotRegistered: a well-formed, correctly signed response
// from a key that is not in the list.
//
// A user told "not registered" when the file was tampered with keeps retrying a device that was
// never the problem; an operator who sees "refused" for an unprovisioned device hunts for a fault
// that does not exist.

export class Refusal extends Error {}

export class NotRegistered extends Error {
  uid: string;

  constructor(message: string, uid: string) {
    super(message);
    this.uid = uid;
  }
}
