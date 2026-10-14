import {WorkflowError} from './feeService.js';
export function audioNote(data){
 if(data.audio_note==null)return {note:null,duration:null};
 const value=data.audio_note;
 if(typeof value!=='string'||!/^data:audio\/mp4;base64,[A-Za-z0-9+/]+=*$/.test(value))throw new WorkflowError('Choose a recorded voice note',400);
 const bytes=Buffer.from(value.split(',')[1],'base64');
 if(bytes.length<24||bytes.length>350000||bytes.toString('ascii',4,8)!=='ftyp'||!['M4A ','isom','mp42'].includes(bytes.toString('ascii',8,12)))throw new WorkflowError('Voice note must be an M4A recording smaller than 350 KB',400);
 if(!Number.isInteger(data.audio_duration)||data.audio_duration<1||data.audio_duration>60)throw new WorkflowError('Voice notes must last between 1 and 60 seconds',400);
 return {note:value,duration:data.audio_duration};
}
