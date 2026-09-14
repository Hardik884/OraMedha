/** A history that cannot be answered from: another clinic's versions, mixed records, or invalid times. */
export class HistoryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryIntegrityError";
  }
}
