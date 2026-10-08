import { v7 } from 'uuid';

/**
 * UUIDv7 ids in canonical lowercase (section 1.3 of spec 001). `uuid` keeps one state per process,
 * so an id generated later sorts after an earlier one, within one millisecond too, and PostgreSQL's
 * `uuid` order is creation order on one replica.
 */
export class UuidV7Generator {
  next(): string {
    return v7();
  }
}
