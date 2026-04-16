-- Create shop_settings table
CREATE TABLE IF NOT EXISTS public.shop_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key TEXT UNIQUE NOT NULL,
    setting_value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed MOA Template with defaults
INSERT INTO public.shop_settings (setting_key, setting_value)
VALUES ('moa_template', '{
    "terms_text": "1. This Memorandum of Agreement is renewable every TEN (10) days.\n2. The Seller shall advise the Buyer of any change of address or mobile number.\n3. This is not a PAWN; this is an extended purchase sale known as the buyback agreement.\n4. JCLB BUY BACK SHOP OPC has the right to open the sealed item and put on display and dispose this item after the extension period expires.\n5. Unpurchased item and all penalties become binding to this MOA.\n6. The seller declares all information and submitted documents are true and authentic.\n7. There are no FINANCE or INTEREST charges connected with this MOA.\n8. In case of loss of this MOA, bring a valid ID and notarized affidavit before buyback period expires.\n9. Representative''s signature is required when authorization from owner is used.\n10. Seller confirms ownership and freedom from liens and encumbrances.",
    "labels": {
        "originalCopy": "Original copy",
        "moaTitle": "Memorandum of Agreement Slip",
        "unitCode": "UNIT CODE:",
        "purchasedDate": "Purchased Date:",
        "idsPresented": "ID(s) Presented:",
        "maturityDate": "Maturity Date:",
        "expiryDate": "Expiry Date:",
        "customerIntro": "I, Mr./Mrs.",
        "legalAgeResident": "of legal age and a resident of",
        "agreementText": "agree to transfer and convey by way of sale with a right to repurchase back.",
        "repayIntro": "If I have repurchased the above unit, I shall pay the amount of",
        "plusText": "plus",
        "storageFeeText": "every 10 days as storage fee. Penalty amounting to",
        "overdueText": "applies when overdue.",
        "financialDetails": "Financial Details",
        "unitDescription": "Unit Description",
        "amount": "Amount:",
        "storageFee": "Storage fee:",
        "parkingFee": "Parking fee:",
        "netProceeds": "Net Proceeds:",
        "brandModel": "Brand and model:",
        "itemsIncluded": "Items included:",
        "condition": "Condition:",
        "serialNo": "Serial No.:",
        "memory": "Memory:",
        "dateHeader": "Date",
        "storageHeader": "Storage",
        "periodHeader": "Period",
        "extendHeader": "Extend",
        "signHeader": "Sign",
        "adviseText": "SELLER IS ADVISED TO READ AND UNDERSTAND THE TERMS AND CONDITIONS ON THE REVERSE SIDE HEREOF",
        "termsHeading": "TERMS AND CONDITIONS",
        "sellerSignature": "(Name and Signature of Seller)",
        "authorizedText": "I HEREBY AUTHORIZED",
        "representativeSignature": "(Name and Signature of Representative)"
    }
}')
ON CONFLICT (setting_key) DO NOTHING;
