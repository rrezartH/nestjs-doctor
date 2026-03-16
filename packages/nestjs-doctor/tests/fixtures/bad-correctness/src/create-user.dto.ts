import { ValidateNested } from 'class-validator';

class AddressDto {
  street: string;
  city: string;
}

class ItemDto {
  name: string;
  price: number;
}

export class CreateUserDto {
  @ValidateNested()
  address: AddressDto;

  @ValidateNested()
  items: ItemDto[];
}
