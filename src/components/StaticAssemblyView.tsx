import React from "react";

const assemblyData = [
  {
    address: "0x7FFD26DFC320",
    bytes: "48 83 EC 48",
    mnemonic: "sub",
    operands: "rsp, 0x48",
  },
  { address: "0x7FFD26DFC324", bytes: "4C 8B C9", mnemonic: "mov", operands: "r9, rcx" },
  {
    address: "0x7FFD26DFC327",
    bytes: "48 8B 05 62 74 19 00",
    mnemonic: "mov",
    operands: "rax, qword ptr [rip + 0x197462]",
  },
  { address: "0x7FFD26DFC32E", bytes: "48 85 C0", mnemonic: "test", operands: "rax, rax" },
  { address: "0x7FFD26DFC331", bytes: "74 24", mnemonic: "je", operands: "0x7ffd26dfc357" },
  {
    address: "0x7FFD26DFC333",
    bytes: "48 8D 0D 56 DE 03 00",
    mnemonic: "lea",
    operands: "rcx, [rip + 0x3de56]",
  },
  { address: "0x7FFD26DFC33A", bytes: "4C 8B C2", mnemonic: "mov", operands: "r8, rdx" },
  { address: "0x7FFD26DFC33D", bytes: "49 8B D1", mnemonic: "mov", operands: "rdx, r9" },
  { address: "0x7FFD26DFC340", bytes: "48 3B C1", mnemonic: "cmp", operands: "rax, rcx" },
  { address: "0x7FFD26DFC343", bytes: "74 09", mnemonic: "je", operands: "0x7ffd26dfc34e" },
];

const longAssemblyData = [
  ...assemblyData,
  ...assemblyData,
  ...assemblyData,
  ...assemblyData,
  ...assemblyData,
];

const StaticAssemblyView = () => {
  return (
    <div className="p-2">
      <pre className="font-mono text-sm text-foreground">
        {longAssemblyData.map((line, index) => (
          <div key={index} className="flex">
            <span className="text-muted-foreground w-40">{line.address}</span>
            <span className="text-muted-foreground w-40">{line.bytes}</span>
            <span className="text-blue-400 w-16">{line.mnemonic}</span>
            <span>{line.operands}</span>
          </div>
        ))}
      </pre>
    </div>
  );
};

export default StaticAssemblyView; 