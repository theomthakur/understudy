/**
 * Synthetic data for the stand-in back-office app.
 *
 * Everything here is fabricated. No real PII, no real account numbers.
 * Member IDs are deliberately short and obviously fake.
 */

export interface Account {
  accountNumber: string;
  type: "SAVINGS" | "CHECKING" | "CERTIFICATE";
  balance: number;
  status: "OPEN" | "CLOSED" | "FROZEN";
  openedOn: string;
}

export interface Member {
  memberId: string;
  firstName: string;
  lastName: string;
  ssnLast4: string;
  phone: string;
  email: string;
  joinedOn: string;
  branch: string;
  restricted: boolean; // triggers a permission denial
  accounts: Account[];
}

export const MEMBERS: Member[] = [
  {
    memberId: "12345",
    firstName: "Dana",
    lastName: "Whitfield",
    ssnLast4: "4417",
    phone: "555-0142",
    email: "dana.whitfield@example.invalid",
    joinedOn: "2016-03-11",
    branch: "Riverside",
    restricted: false,
    accounts: [
      { accountNumber: "SV-100241", type: "SAVINGS", balance: 8241.55, status: "OPEN", openedOn: "2016-03-11" },
      { accountNumber: "CK-100242", type: "CHECKING", balance: 1930.08, status: "OPEN", openedOn: "2016-03-11" },
    ],
  },
  {
    memberId: "22871",
    firstName: "Marcus",
    lastName: "Oyelaran",
    ssnLast4: "9002",
    phone: "555-0188",
    email: "marcus.o@example.invalid",
    joinedOn: "2019-07-02",
    branch: "Northgate",
    restricted: false,
    accounts: [
      { accountNumber: "SV-220114", type: "SAVINGS", balance: 402.19, status: "OPEN", openedOn: "2019-07-02" },
      { accountNumber: "CD-220115", type: "CERTIFICATE", balance: 15000.0, status: "OPEN", openedOn: "2021-01-15" },
    ],
  },
  {
    memberId: "30099",
    firstName: "Priya",
    lastName: "Raman",
    ssnLast4: "1130",
    phone: "555-0199",
    email: "priya.raman@example.invalid",
    joinedOn: "2013-11-20",
    branch: "Riverside",
    restricted: true, // permission denial path
    accounts: [
      { accountNumber: "SV-300871", type: "SAVINGS", balance: 61200.4, status: "OPEN", openedOn: "2013-11-20" },
    ],
  },
  {
    memberId: "44120",
    firstName: "Ellis",
    lastName: "Vance",
    ssnLast4: "7788",
    phone: "555-0121",
    email: "ellis.vance@example.invalid",
    joinedOn: "2022-05-30",
    branch: "Southfield",
    restricted: false,
    accounts: [
      { accountNumber: "CK-441201", type: "CHECKING", balance: 77.42, status: "FROZEN", openedOn: "2022-05-30" },
    ],
  },
];

export function findMember(memberId: string): Member | undefined {
  return MEMBERS.find((m) => m.memberId === memberId.trim());
}

export function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
