import { DataTypes, Model, Sequelize } from 'sequelize';

// What a delivery resolved to. NULL means received but not yet resolved.
export const CallbackOutcome = {
  Credited: 'credited',
  DuplicateIgnored: 'duplicate_ignored',
  AmountMismatch: 'amount_mismatch',
  UnknownRef: 'unknown_ref',
  MarkedFailed: 'marked_failed',
} as const;
export type CallbackOutcome = (typeof CallbackOutcome)[keyof typeof CallbackOutcome];

export class PspCallback extends Model {
  declare id: string;
  declare pspRef: string;
  declare status: string;
  declare amount: string | null;
  declare payload: unknown;
  declare outcome: CallbackOutcome | null;
  declare detail: string | null;
  declare fundingTransactionId: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export function initPspCallback(sequelize: Sequelize): void {
  PspCallback.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      pspRef: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.TEXT, allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: true },
      payload: { type: DataTypes.JSONB, allowNull: false },
      outcome: { type: DataTypes.TEXT, allowNull: true },
      detail: { type: DataTypes.TEXT, allowNull: true },
      fundingTransactionId: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, tableName: 'psp_callbacks', underscored: true },
  );
}
