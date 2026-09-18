import Foundation
import Security

// Secrets cross stdin/stdout only, never process arguments or diagnostics.
do {
  let bytes = FileHandle.standardInput.readDataToEndOfFile()
  guard let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
  else { throw NSError(domain: "Keychain", code: 1) }
  guard let account = request["account"] as? String, let operation = request["operation"] as? String
  else { throw NSError(domain: "Keychain", code: 1) }
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.isbkch.YouTube-AI-Studio.analytics",
    kSecAttrAccount as String: account,
  ]
  var result: Any = NSNull()
  if operation == "read" {
    var read = query
    read[kSecReturnData as String] = true
    read[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(read as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data {
      result = try JSONSerialization.jsonObject(with: data)
    } else if status != errSecItemNotFound {
      throw NSError(domain: "Keychain", code: Int(status))
    }
  } else if operation == "write" {
    guard let value = request["value"] else { throw NSError(domain: "Keychain", code: 1) }
    let data = try JSONSerialization.data(withJSONObject: value)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      let added = SecItemAdd(item as CFDictionary, nil)
      if added != errSecSuccess { throw NSError(domain: "Keychain", code: Int(added)) }
    } else if status != errSecSuccess {
      throw NSError(domain: "Keychain", code: Int(status))
    }
    result = ["ok": true]
  } else if operation == "delete" {
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
      throw NSError(domain: "Keychain", code: Int(status))
    }
    result = ["ok": true]
  } else {
    throw NSError(domain: "Keychain", code: 2)
  }
  let output = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
  FileHandle.standardOutput.write(output)
} catch {
  FileHandle.standardError.write(
    Data("Analytics Keychain operation failed. Unlock your login keychain and retry.\n".utf8))
  exit(1)
}
