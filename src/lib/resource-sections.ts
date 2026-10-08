// Resource sections (PLAN.md §7). Pure: shared by server code and client forms.
export const SECTIONS = {
  SOP: { label: "Tutorials & SOPs", accepts: "link" },
  TG_MEDIA: { label: "TG media", accepts: "file" },
  CREATOR_TEMPLATE: { label: "Creator templates", accepts: "either" },
  MEDIA_POOL: { label: "Media pool", accepts: "file" },
} as const;
export type Section = keyof typeof SECTIONS;
export const SECTION_KEYS = Object.keys(SECTIONS) as Section[];
