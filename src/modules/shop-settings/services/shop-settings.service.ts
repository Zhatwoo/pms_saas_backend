import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import {
  environmentCreateFields,
  getEnvironment,
} from '../../../common/utils/authorization.util';

@Injectable()
export class ShopSettingsService {
  constructor(
    private supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  async getSetting(key: string, user: AuthenticatedUserProfile) {
    const environment = getEnvironment(user);
    const data = await this.prisma.shop_settings.findFirst({
      where: { setting_key: key, environment },
      select: { setting_value: true },
    });

    if (!data) {
      // Auto-seed defaults for missing keys to avoid throwing 404/crashing the frontend
      let defaultValue: any = null;

      if (key === 'moa_template') {
        defaultValue = {
          terms_text: "1. This Memorandum of Agreement is renewable every TEN (10) days.\n2. The Seller shall advise the Buyer of any change of address or mobile number.\n3. This is not a PAWN; this is an extended purchase sale known as the buyback agreement.\n4. JCLB BUY BACK SHOP OPC has the right to open the sealed item and put on display and dispose this item after the extension period expires.\n5. Unpurchased item and all penalties become binding to this MOA.\n6. The seller declares all information and submitted documents are true and authentic.\n7. There are no FINANCE or INTEREST charges connected with this MOA.\n8. In case of loss of this MOA, bring a valid ID and notarized affidavit before buyback period expires.\n9. Representative's signature is required when authorization from owner is used.\n10. Seller confirms ownership and freedom from liens and encumbrances.",
          labels: {
            originalCopy: "Original copy",
            moaTitle: "Memorandum of Agreement Slip",
            unitCode: "UNIT CODE:",
            purchasedDate: "Purchased Date:",
            idsPresented: "ID(s) Presented:",
            maturityDate: "Maturity Date:",
            expiryDate: "Expiry Date:",
            customerIntro: "I, Mr./Mrs.",
            legalAgeResident: "of legal age and a resident of",
            agreementText: "agree to transfer and convey by way of sale with a right to repurchase back.",
            repayIntro: "If I have repurchased the above unit, I shall pay the amount of",
            plusText: "plus",
            storageFeeText: "every 10 days as storage fee. Penalty amounting to",
            overdueText: "applies when overdue.",
            financialDetails: "Financial Details",
            unitDescription: "Unit Description",
            amount: "Amount:",
            storageFee: "Storage fee:",
            parkingFee: "Parking fee:",
            netProceeds: "Net Proceeds:",
            brandModel: "Brand and model:",
            itemsIncluded: "Items included:",
            condition: "Condition:",
            serialNo: "Serial No.:",
            memory: "Memory:",
            dateHeader: "Date",
            storageHeader: "Storage",
            periodHeader: "Period",
            extendHeader: "Extend",
            signHeader: "Sign",
            adviseText: "SELLER IS ADVISED TO READ AND UNDERSTAND THE TERMS AND CONDITIONS ON THE REVERSE SIDE HEREOF",
            termsHeading: "TERMS AND CONDITIONS",
            sellerSignature: "(Name and Signature of Seller)",
            authorizedText: "I HEREBY AUTHORIZED",
            representativeSignature: "(Name and Signature of Representative)"
          }
        };
      } else if (key === 'general') {
        defaultValue = {
          shopInfo: {
            shopName: "JCLB BUY BACK SHOP",
            shopAddress: "123 Main Street, Manila, Philippines",
            phoneNumber: "+63 2 1234 5678",
            email: "info@jclbbuyback.com"
          },
          policies: {
            interestRate: "3.5",
            pawnDuration: "30",
            gracePeriod: "3"
          }
        };
      } else if (key === 'interest_rates') {
        defaultValue = [
          {
            id: "group-1",
            name: "Gadgets",
            categories: ["Smartphone", "Laptop & PC", "Gaming Console"],
            first5Days: 5,
            first5DaysLimit: 5,
            day10: 10,
            day10Limit: 10,
            day20Additional: 10,
            day20Limit: 20,
            day30Additional: 10,
            gracePeriodAdditional: 10,
            defaultDuration: 30,
            gracePeriodDuration: 4,
            isExpanded: true
          },
          {
            id: "group-2",
            name: "General & Appliances",
            categories: ["Appliances", "Cameras", "Smartwatches", "Audio & Earphones", "Other Items"],
            first5Days: 7,
            first5DaysLimit: 5,
            day10: 12,
            day10Limit: 10,
            day20Additional: 10,
            day20Limit: 20,
            day30Additional: 10,
            gracePeriodAdditional: 10,
            defaultDuration: 30,
            gracePeriodDuration: 4,
            isExpanded: true
          }
        ];
      }

      if (defaultValue !== null) {
        const created = await this.prisma.shop_settings.create({
          data: {
            setting_key: key,
            setting_value: defaultValue,
            updated_at: new Date(),
            ...environmentCreateFields(user),
          },
          select: { setting_value: true }
        });
        return created.setting_value;
      }

      throw new NotFoundException(`Setting ${key} not found`);
    }

    return data.setting_value;
  }

  async setSetting(key: string, value: any, user: AuthenticatedUserProfile) {
    try {
      const environment = getEnvironment(user);
      const existing = await this.prisma.shop_settings.findFirst({
        where: { setting_key: key, environment },
        select: { id: true },
      });

      if (!existing) {
        return await this.prisma.shop_settings.create({
          data: {
            setting_key: key,
            setting_value: value,
            updated_at: new Date(),
            ...environmentCreateFields(user),
          },
        });
      }

      return await this.prisma.shop_settings.update({
        where: { id: existing.id },
        data: {
          setting_key: key,
          setting_value: value,
          updated_at: new Date(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new InternalServerErrorException(message);
    }
  }
}
