import {
  MembraneWebRTC,
  Peer,
  SerializedMediaEvent,
} from "@membraneframework/membrane-webrtc-js"
import { Socket, Push } from "phoenix"
import { Subject } from "rxjs"

import { LOCAL_PEER_ID, AUDIO_TRACK_CONSTRAINTS } from "@common/consts"

import { UserInfo } from "../common/types"

export class ChatService {
  private participants: UserInfo[] = []
  private peers: Peer[] = []

  private localAudioStream: MediaStream | null = null
  private localAudioTrackIds: string[] = []

  private socket: Socket

  private webrtc: MembraneWebRTC
  private webrtcSocketRefs: string[] = []
  private webrtcChannel

  private subject: Subject<UserInfo[]>

  constructor(roomName: string, subject) {
    this.subject = subject
    this.socket = new Socket("wss://macbook-m1.tailnet-a122.ts.net:4000/socket")
    this.socket.connect()
    this.webrtcChannel = this.socket.channel(`room:` + roomName, {
      isSimulcastOn: false, // audio not need simulcast
    })

    this.webrtcChannel.onError((e) => {
      this.socketOff()
      this.subject.error(e)
    })

    this.webrtcChannel.onClose(() => {
      this.socketOff()
      this.subject.error(new Error("on close!"))
    })

    this.webrtcSocketRefs.push(this.socket.onError(this.leave))
    this.webrtcSocketRefs.push(this.socket.onClose(this.leave))

    this.webrtc = new MembraneWebRTC({
      callbacks: {
        onSendMediaEvent: (mediaEvent: SerializedMediaEvent) => {
          console.log("onSendMediaEvent")
          console.log(mediaEvent)
          this.webrtcChannel.push("mediaEvent", { data: mediaEvent })
        },
        onConnectionError: () => {
          this.subject.error(
            new Error(
              "Cannot connect to server, refresh the page and try again"
            )
          )
        },
        onJoinSuccess: (_peerId, peersInRoom) => {
          console.log("onJoinSuccess")
          console.log(peersInRoom)
          this.localAudioStream?.getTracks().forEach((track) => {
            const trackId = this.webrtc.addTrack(
              track,
              this.localAudioStream!,
              {
                active: true,
              }
            )
            this.localAudioTrackIds.push(trackId)
          })
          peersInRoom.map((p) => {
            this.addPeer(p)
          })
          this.setParticipantsList()
        },
        onJoinError: (_metadata) => {
          throw `Peer denied.`
        },
        onTrackReady: (ctx) => {
          console.log("onTrackReady")
          this.attachStream(ctx.peer.id, ctx.stream)
          if (ctx.track?.kind === "audio") {
            this.updateTrackStatus(ctx.peer.id, ctx.metadata.active)
          }
        },
        onTrackAdded: (_ctx) => {},
        onTrackRemoved: (_ctx) => {},
        onTrackUpdated: (ctx) => {
          console.log("onTrackUpdated")
          if (ctx.track?.kind == "audio") {
            this.updateTrackStatus(ctx.peer.id, ctx.metadata.active)
          }
        },
        onPeerJoined: (peer) => {
          console.log("onPeerJoined")
          console.log(peer)
          this.addPeer(peer)
          this.setParticipantsList()
        },
        onPeerLeft: (peer) => {
          console.log("onPeerLeft")
          console.log(peer)
          this.removePeer(peer)
          this.setParticipantsList()
        },
        onPeerUpdated: (_ctx) => {},
        onTrackEncodingChanged: (_ctx) => {},
      },
    })

    this.webrtcChannel.on("mediaEvent", (event: any) => {
      console.log("mediaEvent")
      console.log(event.data)
      this.webrtc.receiveMediaEvent(event.data)
    })
  }

  public join = async (nickName: string) => {
    console.log("start join....")
    console.log(nickName)
    await this.askForPermissions()
    try {
      this.localAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_TRACK_CONSTRAINTS,
      })
    } catch (error) {
      console.error("Error while getting local audio stream", error)
    }
    const localPeer: Peer = {
      id: LOCAL_PEER_ID,
      metadata: { displayName: nickName, active: true },
      trackIdToMetadata: null,
    }
    this.addPeer(localPeer)
    this.attachStream(LOCAL_PEER_ID, this.localAudioStream)
    await this.phoenixChannelPushResult(this.webrtcChannel.join())

    this.webrtc.join({ displayName: nickName })
  }

  private updateParticipants = (users: UserInfo[]) => {
    this.participants = users
    this.subject.next(this.participants)
  }

  private setParticipantsList = () => {
    const users: UserInfo[] = []
    console.log("setParticipantsList=>peers")
    console.log(this.peers)
    this.peers.map((p) => {
      users.push({ name: p.metadata.displayName, peerId: p.id })
    })
    console.log("setParticipantsList")
    console.log(users)
    this.updateParticipants(users)
  }

  private attachStream = (peerId: string, audio: MediaStream) => {
    console.log("attachStream")
    console.log(this.participants)
    this.updateParticipants(
      this.participants.map((p) => {
        if (p.peerId === peerId) {
          p.audioStream = audio
        }
        return p
      })
    )
  }

  private updateTrackStatus = (peerId: string, status: boolean) => {
    console.log("updateTrackStatus")
    console.log(this.participants)
    this.updateParticipants(
      this.participants.map((p) => {
        if (p.peerId === peerId) {
          p.muteState = status
        }
        return p
      })
    )
  }

  private socketOff = () => {
    this.socket.off(this.webrtcSocketRefs)
    while (this.webrtcSocketRefs.length > 0) {
      this.webrtcSocketRefs.pop()
    }
  }

  private leave = () => {
    this.webrtc.leave() // notify webrtc engine leave
    this.webrtcChannel.leave() // notify phoniex channel leave
    this.socketOff() // close socket
  }

  private addPeer = (peer: Peer) => {
    const findPeers = this.peers.filter((p) => p.id === peer.id)
    if (findPeers.length === 0) {
      this.peers.push(peer)
    }
  }

  private removePeer = (peer: Peer) => {
    this.peers = this.peers.filter((p) => p.id !== peer.id)
  }

  private askForPermissions = async (): Promise<void> => {
    let tmpVideoStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    })

    // stop tracks
    // in other case, next call to getUserMedia may fail
    // or won't respect media constraints
    tmpVideoStream.getTracks().forEach((track) => track.stop())
  }

  private phoenixChannelPushResult = async (push: Push): Promise<any> => {
    return new Promise((resolve, reject) => {
      push
        .receive("ok", (response: any) => resolve(response))
        .receive("error", (response: any) => reject(response))
    })
  }
}
