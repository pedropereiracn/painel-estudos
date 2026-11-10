// Le eventos do Calendario (EventKit), somente leitura. Saida: JSON no stdout.
// Uso: ler-calendario [dias]   (padrao 21, a partir de 00:00 de hoje)
import Foundation
import EventKit

func sair(_ obj: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(0)
}

let dias = CommandLine.arguments.count > 1 ? (Int(CommandLine.arguments[1]) ?? 21) : 21
let store = EKEventStore()
func nomeStatus(_ s: EKAuthorizationStatus) -> String {
  switch s {
  case .notDetermined: return "nao_determinado"
  case .restricted: return "restrito"
  case .denied: return "negado"
  case .fullAccess: return "acesso_total"
  case .writeOnly: return "so_escrita"
  @unknown default: return "desconhecido"
  }
}
var status = EKEventStore.authorizationStatus(for: .event)
if status == .notDetermined {
  let sem = DispatchSemaphore(value: 0)
  store.requestFullAccessToEvents { _, _ in sem.signal() }
  _ = sem.wait(timeout: .now() + 120)
  status = EKEventStore.authorizationStatus(for: .event)
}
if status != .fullAccess {
  sair(["ok": false, "status": nomeStatus(status),
        "erro": "Sem permissão de leitura do Calendário (status: \(nomeStatus(status)))."])
}
let cal = Calendar.current
let inicio = cal.startOfDay(for: Date())
let fim = cal.date(byAdding: .day, value: dias, to: inicio)!
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
iso.timeZone = TimeZone(identifier: "America/Sao_Paulo")
let pred = store.predicateForEvents(withStart: inicio, end: fim, calendars: nil)
let eventos = store.events(matching: pred).sorted { $0.startDate < $1.startDate }.map { e -> [String: Any] in
  [
    "titulo": e.title ?? "",
    "inicio": iso.string(from: e.startDate),
    "fim": iso.string(from: e.endDate),
    "dia_inteiro": e.isAllDay,
    "calendario": e.calendar?.title ?? "",
    "disponibilidade": e.availability == .free ? "livre" : "ocupado",
  ]
}
sair(["ok": true, "status": "acesso_total", "eventos": eventos, "calendarios": store.calendars(for: .event).count])
