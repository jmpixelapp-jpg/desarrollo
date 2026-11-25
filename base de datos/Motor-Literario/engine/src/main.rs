//! Proceso JSON-RPC por stdin/stdout para la integración local.
//! stdout queda reservado exclusivamente para respuestas del protocolo.

use std::io::{self, BufRead, Write};

use motor_literario_core::JsonRpcServer;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut server = JsonRpcServer::new();

    for line in stdin.lock().lines() {
        let line = line?;
        let response = server.handle_line(&line);
        writeln!(output, "{response}")?;
        output.flush()?;

        if server.should_exit() {
            break;
        }
    }

    Ok(())
}
