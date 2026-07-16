import { createApplicationServices, ApplicationServices } from "./item-services.js";
import { CsvItemBackend } from "./csv-backend.js";
import { MockItemBackend } from "./mock-backend.js";
import { OnePasswordService } from "./onepassword.js";
import { OnePasswordItemBackend } from "./onepassword-backend.js";

export function createDefaultApplicationServices(onePassword: OnePasswordService): ApplicationServices {
    return createApplicationServices([
        new OnePasswordItemBackend(onePassword),
        new CsvItemBackend(),
        new MockItemBackend(),
    ]);
}
