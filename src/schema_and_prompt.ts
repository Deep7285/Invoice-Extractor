// src/schema_and_prompt.ts
export const SCHEMA_ID = "invoice_v1";

export const JSON_SCHEMA = {
  name: SCHEMA_ID,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      seller: {
        type: "object",
        additionalProperties: false,
        properties: {
          company_name: { type: ["string", "null"] },
          gstin: { type: ["string", "null"] },
          address: { type: ["string", "null"] }
        },
        required: ["company_name", "gstin", "address"]
      },
      invoice: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: ["string", "null"] },
          date: { type: ["string", "null"] },              // DD-MM-YYYY
          transaction_id: { type: ["string", "null"] }
        },
        required: ["number", "date", "transaction_id"]
      },
      taxes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["CGST", "SGST", "IGST", "CESS", "OTHER"] },
            rate_percent: { type: ["number", "null"] },
            amount: { type: ["number", "null"] }
          },
          required: ["type", "rate_percent", "amount"]
        }
      },
      amounts: {
        type: "object",
        additionalProperties: false,
        properties: {
          taxable_amount: { type: ["number", "null"] },
          total_amount: { type: ["number", "null"] }
        },
        required: ["taxable_amount", "total_amount"]
      }
    },
    required: ["seller", "invoice", "taxes", "amounts"]
  },
  strict: true
} as const;

export const SYSTEM_PROMPT = `You are an expert invoice parser for Indian GST invoices.
Return ONLY a JSON object that strictly matches the provided JSON schema.
- If a field is not present, set it to null (do not guess).
- Normalize date to DD-MM-YYYY when possible.
- 'seller.company_name' is the SELLER/ISSUER (not the buyer).
- Extract all tax lines (CGST/SGST/IGST/... with rate and amount).
- Choose the grand total for total_amount.
- No text outside the JSON.`;

export const USER_INSTRUCTIONS = `Parse the attached invoice content (images) into the schema.
Prefer explicit labels; if absent, infer from layout, headers, or letterhead.
If multiple totals exist, return the grand total (post-tax). Use null for missing fields.`;
