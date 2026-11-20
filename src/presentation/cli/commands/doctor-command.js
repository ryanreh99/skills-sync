import { runDoctorUseCase } from "../../../app/use-cases/doctor/run-doctor-use-case.js";
import { presentDoctorReport } from "../../presenters/doctor-presenter.js";

export async function cmdDoctor(profileOverride) {
  const report = await runDoctorUseCase({ profileOverride });
  presentDoctorReport(report);
}
