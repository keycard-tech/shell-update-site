export class Refusal extends Error {}

export class NotRegistered extends Error {
  uid: string;

  constructor(message: string, uid: string) {
    super(message);
    this.uid = uid;
  }
}
