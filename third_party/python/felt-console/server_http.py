import os
import json

from http.server import BaseHTTPRequestHandler, HTTPServer

class requestHandler(BaseHTTPRequestHandler):

    def do_GET(self):

        components = self.path.split("/")[1:]
        filename = "_".join(components)

        source_file = os.path.join("{}.json".format(filename))
        if not os.path.exists(source_file):
            print("Cannot open", source_file)
            return

        with open(source_file, "r") as source:
            msg = source.read()
            self.send_response(200, "Success")
            self.send_header("Content-Length", len(msg))
            self.end_headers()
            self.wfile.write(bytes(msg, "utf8"))

httpd = HTTPServer(('', 8000), requestHandler)
httpd.serve_forever()
