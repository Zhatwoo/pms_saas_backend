export class CreateCustomerDto {
  full_name!: string;
  address!: string;
  barangay?: string;
  city?: string;
  province?: string;
  contact_number?: string;
  email?: string;
  id_presented?: string;
  branch_id?: string;
}
