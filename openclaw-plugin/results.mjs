// OpenClaw history may retain only the text item. Its card parser checks an explicit
// isError in that JSON before treating a nested business "error" as a tool failure.
export function toolResult(result) {
  const isError=result.ok!==true;
  return {isError,content:[{type:'text',text:JSON.stringify({...result,isError})}]};
}
