import os
import json
from simple_websocket_server import WebSocketServer, WebSocket


class SimpleEcho(WebSocket):
    def handle(self):
        print("received", self.data)
        j = json.loads(self.data)
        print("received J", j)
        cmd = j["command"].upper()
        print("received command", cmd)

        filename = None
        if cmd == "INIT":
            filename = j.get("specific", "default")
        elif cmd == "FELT":
            filename = "felt"
        
        source_file = os.path.join("{}.json".format(filename))
        if not os.path.exists(source_file):
            print("Cannot open", source_file)
            return

        with open(source_file, "r") as source:
            msg = source.read()
            print("sending", msg)
            self.send_message(msg)

    def connected(self):
        print(self.address, 'connected')

    def handle_close(self):
        print(self.address, 'closed')


server = WebSocketServer('', 3012, SimpleEcho)
server.serve_forever()
