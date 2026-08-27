export const MEDTECHSERVICE_REQUISITES = {
  name: "ООО «МедТехСервис»",
  inn: "7806410615",
  address: "195043, Россия, г. Санкт-Петербург, ул. 6-я Жерновская, д. 19",
  phone: "(812) 640-84-52",
  email: "mtserv@mail.ru"
} as const;

export type WorkActPartCondition = "G" | "N" | "B";

export interface WorkActEquipmentRow {
  readonly name: string;
  readonly serialNumber: string;
  readonly meterReading?: number;
}

export interface WorkActWorkRow {
  readonly name: string;
  readonly modifier?: "G" | "N";
  readonly hours?: number;
}

export interface WorkActPartRow {
  readonly articleNumber: string;
  readonly name: string;
  readonly condition: WorkActPartCondition;
  readonly quantity: number;
}

export interface WorkActParty {
  readonly heading: "От Заказчика" | "От Исполнителя";
  readonly position: string;
  readonly fullName: string;
}

export interface WorkActModel {
  readonly company: typeof MEDTECHSERVICE_REQUISITES;
  readonly number: string;
  readonly contractNumber: string;
  readonly callDate: string;
  readonly visitDate: string;
  readonly completionDate: string;
  readonly workStartedAt: string;
  readonly workFinishedAt: string;
  readonly customer: {
    readonly name: string;
    readonly address: string;
    readonly contactFullName: string;
    readonly contactPhone: string;
  };
  readonly equipment: readonly WorkActEquipmentRow[];
  readonly works: readonly WorkActWorkRow[];
  readonly callReason: string;
  readonly workDescription: string;
  readonly recommendations: string;
  readonly userRemarks: string;
  readonly parts: readonly WorkActPartRow[];
  readonly marks: {
    readonly workCompleted: boolean;
    readonly apparatusApproved: boolean;
    readonly customerHasNoClaims: boolean;
    readonly continuedInPrimary: boolean;
  };
  readonly customerParty: WorkActParty;
  readonly contractorParty: WorkActParty;
}

interface WorkActCardSource {
  readonly task: {
    readonly number: string;
    readonly contractNumber?: string;
    readonly contractId?: string;
    readonly callDate?: string;
    readonly visitDate?: string;
    readonly completedAt?: string;
    readonly workStartedAt?: string;
    readonly workFinishedAt?: string;
    readonly meterReading?: number;
    readonly workModifier?: "G" | "N";
    readonly hours?: number;
    readonly callReason?: string;
    readonly workDescription?: string;
    readonly recommendations?: string;
    readonly userRemarks?: string;
    readonly workCompleted?: boolean;
    readonly apparatusApproved?: boolean;
    readonly customerHasNoClaims?: boolean;
    readonly continuedInPrimary?: boolean;
    readonly customer?: {
      readonly siteName: string;
      readonly address: string;
      readonly contactFullName?: string;
      readonly contactPhone?: string;
    };
  };
  readonly equipment?: {
    readonly manufacturer: string;
    readonly model: string;
    readonly serialNumber: string;
    readonly lastMeterReading?: number;
  };
  readonly engineer?: { readonly fullName: string };
  readonly workType?: { readonly name: string };
  readonly closure?: {
    readonly submittedByName?: string;
    readonly meterReading?: number;
    readonly workModifier?: "G" | "N";
    readonly hours?: number;
    readonly workCompleted?: boolean;
    readonly apparatusApproved?: boolean;
    readonly customerHasNoClaims?: boolean;
    readonly callReason?: string;
    readonly workDescription?: string;
    readonly recommendations?: string;
    readonly userRemarks?: string;
    readonly continuedInPrimary?: boolean;
  };
  readonly parts: readonly {
    readonly articleNumber: string;
    readonly name: string;
    readonly quantity: number;
    readonly condition: WorkActPartCondition;
  }[];
}

export interface WorkActBuildOverrides {
  readonly equipment?: readonly WorkActEquipmentRow[];
  readonly works?: readonly WorkActWorkRow[];
}

function value<T>(taskValue: T | undefined, closureValue: T | undefined): T | undefined {
  return taskValue ?? closureValue;
}

/** Собирает неизменяемый снимок печатного акта из тех же данных, что видны в карточке задачи. */
export function buildWorkAct(card: WorkActCardSource, overrides: WorkActBuildOverrides = {}): WorkActModel {
  const { task, closure } = card;
  const meterReading = value(task.meterReading, closure?.meterReading);
  const defaultEquipment = card.equipment ? [{
    name: [card.equipment.manufacturer, card.equipment.model].filter(Boolean).join(" "),
    serialNumber: card.equipment.serialNumber,
    ...(meterReading !== undefined || card.equipment.lastMeterReading !== undefined
      ? { meterReading: meterReading ?? card.equipment.lastMeterReading }
      : {})
  }] : [];
  const workModifier = value(task.workModifier, closure?.workModifier);
  const hours = value(task.hours, closure?.hours);
  const defaultWorks = card.workType ? [{
    name: card.workType.name,
    ...(workModifier ? { modifier: workModifier } : {}),
    ...(hours !== undefined ? { hours } : {})
  }] : [];

  return {
    company: MEDTECHSERVICE_REQUISITES,
    number: task.number,
    contractNumber: task.contractNumber ?? task.contractId ?? "",
    callDate: task.callDate ?? "",
    visitDate: task.visitDate ?? "",
    completionDate: task.completedAt ?? "",
    workStartedAt: task.workStartedAt ?? "",
    workFinishedAt: task.workFinishedAt ?? "",
    customer: {
      name: task.customer?.siteName ?? "",
      address: task.customer?.address ?? "",
      contactFullName: task.customer?.contactFullName ?? "",
      contactPhone: task.customer?.contactPhone ?? ""
    },
    equipment: overrides.equipment ?? defaultEquipment,
    works: overrides.works ?? defaultWorks,
    callReason: value(task.callReason, closure?.callReason) ?? "",
    workDescription: value(task.workDescription, closure?.workDescription) ?? "",
    recommendations: value(task.recommendations, closure?.recommendations) ?? "",
    userRemarks: value(task.userRemarks, closure?.userRemarks) ?? "",
    parts: card.parts.map((part) => ({
      articleNumber: part.articleNumber,
      name: part.name,
      condition: part.condition,
      quantity: part.quantity
    })),
    marks: {
      workCompleted: value(task.workCompleted, closure?.workCompleted) === true,
      apparatusApproved: value(task.apparatusApproved, closure?.apparatusApproved) === true,
      customerHasNoClaims: value(task.customerHasNoClaims, closure?.customerHasNoClaims) === true,
      continuedInPrimary: value(task.continuedInPrimary, closure?.continuedInPrimary) === true
    },
    customerParty: {
      heading: "От Заказчика",
      position: "",
      fullName: task.customer?.contactFullName ?? ""
    },
    contractorParty: {
      heading: "От Исполнителя",
      position: "Сервисный инженер",
      fullName: closure?.submittedByName ?? card.engineer?.fullName ?? ""
    }
  };
}
